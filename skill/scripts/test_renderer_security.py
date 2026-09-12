"""S01 security regression tests for the renderer and the host template.

Every test here pins one finding closed by work package S01. A test that merely
exercises the code is not enough: each asserts the behaviour that was wrong before.

Two kinds of assertion appear. Renderer behaviour is asserted by calling
``normalize`` and ``render`` directly. Host behaviour lives in an inline IIFE inside
``assets/explorer.html``, so it is asserted either as a source pin (the template must
contain the fixed expression and must not contain the broken one) or by slicing the
relevant helpers out of the template and executing them under ``node``, the technique
``packages/explorer/server/test_explorer_http.py`` already uses for the live bridge.

Run: python -m unittest discover -s skill/scripts -p 'test_*.py'
"""
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from build_explorer import CONTRACT_VERSION, NAME_CAP, ROOT, TEXT_CAP, normalize, render, script_safe, style_safe

TEMPLATE = (ROOT / 'assets/explorer.html').read_text(encoding='utf-8')
NODE = shutil.which('node')

# The offline artifact's policy is frozen. Any change here is a deliberate decision that
# updates docs/architecture/security-architecture.md and this constant together.
FROZEN_CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"
)


def fixture():
    """A minimal contract-valid graph with a dotted id, a composite key and a JSON column."""
    def col(name, **kw):
        return {'name': name, 'type': 'Integer', 'nullable': False, **kw}
    return {
        'project': {'name': 'Warehouse QA', 'key': 'warehouse-qa', 'dialect': 'postgresql'},
        'tables': [
            {'id': 'warehouse.items', 'schema': 'warehouse', 'name': 'items',
             'primaryKey': ['id'], 'line': 12,
             'allColumns': [col('id'), col('payload_json', type='Text'), col('slot_1'), col('slot_2')]},
        ],
        'links': [],
    }


def run_node(source):
    """Execute a JavaScript snippet and return its stdout, or skip when node is absent."""
    if not NODE:
        raise unittest.SkipTest('node is not on PATH')
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / 'probe.mjs'
        script.write_text(source, encoding='utf-8')
        done = subprocess.run([NODE, str(script)], capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            raise AssertionError(f'node exited {done.returncode}: {done.stderr.strip()}')
        return done.stdout


def sql_helpers(dialect):
    """Slice the host's SQL helpers out of the template and bind them to one dialect.

    The helpers are plain expressions over `data` and `byId`, so they run standalone.
    Slicing rather than duplicating them keeps the test honest: if the template's
    helpers change shape, this stops finding them and fails loudly.
    """
    start = TEMPLATE.index('const quote=')
    end = TEMPLATE.index('const readonly=sql=>')
    helpers = TEMPLATE[start:end]
    readonly_start = TEMPLATE.index('const readonly=sql=>')
    readonly_end = TEMPLATE.index('\n', readonly_start)
    helpers += TEMPLATE[readonly_start:readonly_end]
    return (
        "const data={project:{dialect:%s}};\n"
        "const byId=new Map([['warehouse.items',{id:'warehouse.items',schema:'warehouse',name:'items'}]]);\n"
        "%s\n" % (json.dumps(dialect), helpers)
    )


class HostTemplateSinks(unittest.TestCase):
    """Finding 1a, 2a, 2b, 5 and 6: the host template's escaping and SQL sites."""

    def test_S01_host_source_line_is_escaped(self):
        # table.line reached a text node raw, and detail() runs on load for the
        # initially selected table, so a hostile snapshot needed no interaction.
        self.assertIn('${E(t.file||data.source.file)}:${E(t.line)}</dd>', TEMPLATE)
        self.assertNotIn(':${t.line}</dd>', TEMPLATE)

    def test_S01_no_unescaped_interpolation_into_the_source_fact(self):
        # Every value interpolated into a <dd> must either pass through an escaping
        # helper or be a computed number, which cannot carry markup.
        escaping = ('E(', 'badge(', 'ref(')
        for match in re.finditer(r'<dd>([^<]*\$\{[^}]+\}[^<]*)</dd>', TEMPLATE):
            for expression in re.findall(r'\$\{([^}]+)\}', match.group(1)):
                safe = expression.startswith(escaping) or expression.endswith('.length')
                self.assertTrue(safe, f'unescaped interpolation in a <dd>: {expression}')

    def test_S01_review_sql_never_quotes_the_display_id(self):
        # quote() on a dotted display id yields "warehouse.items", one identifier that
        # does not exist. tableSQL() emits "warehouse"."items" from the separate fields.
        self.assertNotIn('quote(t.id)', TEMPLATE)
        self.assertIn('tableSQL(t.id)', TEMPLATE)

    def test_S01_entity_type_colour_lookup_uses_hasown(self):
        # table.type is free text, so colors['constructor'] resolved to an inherited
        # function, which is truthy and defeated the || fallback.
        self.assertIn("Object.hasOwn(colors,n.t.type)?colors[n.t.type]:'var(--accent)'", TEMPLATE)
        self.assertNotIn("colors[n.t.type]||", TEMPLATE)

    def test_S01_render_unmounts_only_when_the_view_changes(self):
        # The unconditional unmount destroyed React state on every filter keystroke.
        self.assertNotIn("function render(){window.BackendBuddyViews?.unmount()", TEMPLATE)
        self.assertIn("if(mountedView&&mountedView!==state.view)", TEMPLATE)
        self.assertIn("mountedView=state.view;window.BackendBuddyViews.mount(", TEMPLATE)

    def test_S01_offline_csp_is_byte_identical(self):
        self.assertIn(FROZEN_CSP, TEMPLATE)


class HostSqlGeneration(unittest.TestCase):
    """Finding 2b and 2c: qualified identifiers and the dialect gate, executed."""

    def test_S01_repeating_fields_probe_qualifies_the_table(self):
        out = run_node(
            sql_helpers('postgresql')
            + "const names=['slot_1','slot_2'];\n"
            + "console.log(readonly(`SELECT ${names.map(quote).join(', ')}\\nFROM ${tableSQL('warehouse.items')}\\nLIMIT 100;`));\n"
        )
        self.assertIn('"warehouse"."items"', out)
        self.assertNotIn('"warehouse.items"', out)

    def test_S01_structured_payload_probe_is_postgresql_only_syntax_on_postgresql(self):
        out = run_node(sql_helpers('postgresql') + "console.log(jsonProbe({id:'warehouse.items'},'payload_json'));\n")
        self.assertIn('jsonb_typeof', out)
        self.assertIn('"warehouse"."items"', out)
        self.assertNotIn('json_type(', out)

    def test_S01_structured_payload_probe_uses_json_type_on_sqlite(self):
        out = run_node(sql_helpers('sqlite') + "console.log(jsonProbe({id:'warehouse.items'},'payload_json'));\n")
        self.assertIn('json_type(', out)
        self.assertNotIn('jsonb_typeof', out)

    def test_S01_structured_payload_probe_emits_nothing_for_an_unsupported_dialect(self):
        out = run_node(sql_helpers('mysql') + "console.log(JSON.stringify(jsonProbe({id:'warehouse.items'},'payload_json')));\n")
        self.assertEqual(out.strip(), '""')


class CsvFormulaGuard(unittest.TestCase):
    """Finding 5: the export guard was prefix-only."""

    def test_S01_csv_cell_neutralises_formula_vectors(self):
        start = TEMPLATE.index("cell=v=>")
        end = TEMPLATE.index(';', start)
        cell = TEMPLATE[start:end]
        out = run_node(
            "const " + cell + ";\n"
            "const vectors=['=1+1',' =1','\\t=1','\\r=1','+SUM(1)','-2','@A1','plain'];\n"
            "console.log(JSON.stringify(vectors.map(cell)));\n"
        )
        rendered = json.loads(out)
        for value in rendered[:-1]:
            self.assertTrue(value.startswith('"\''), f'formula vector not neutralised: {value!r}')
        self.assertEqual(rendered[-1], '"plain"')


class RendererEscaping(unittest.TestCase):
    """Finding 4: template breakout through the inlined bundle and stylesheet."""

    def test_S01_script_close_is_neutralised_case_insensitively(self):
        for vector in ('</script>', '</SCRIPT>', '</Script >', '</sCrIpT'):
            self.assertNotIn('</script', script_safe(vector).lower())

    def test_S01_style_close_is_neutralised_case_insensitively(self):
        for vector in ('</style>', '</STYLE>', '</Style >'):
            self.assertNotIn('</style', style_safe(vector).lower())

    def test_S01_html_comment_open_is_neutralised_in_both(self):
        self.assertNotIn('<!--', script_safe('x<!--y'))
        self.assertNotIn('<!--', style_safe('x<!--y'))

    def test_S01_rendered_artifact_has_no_raw_breakout_from_the_bundle(self):
        # Render with a bundle and stylesheet that carry the vectors, and assert the
        # output cannot close the elements early. The template's own tags remain.
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / 'assets'
            shutil.copytree(ROOT / 'assets', staged, ignore=shutil.ignore_patterns('extensions'))
            dist = staged / 'extensions/dist'
            dist.mkdir(parents=True)
            (dist / 'extensions.js').write_text("var a='</SCRIPT><img src=x onerror=alert(1)>';var b='<!--';", encoding='utf-8')
            (dist / 'extensions.css').write_text(".x{content:'</STYLE><img src=x onerror=alert(1)>'}", encoding='utf-8')
            import build_explorer
            original = build_explorer.ROOT
            try:
                build_explorer.ROOT = staged.parent
                html_out = build_explorer.render(fixture())
            finally:
                build_explorer.ROOT = original
        # The vectors survive as inert text inside a JS string or CSS content value.
        # The finding is whether they can close the element early, so count the tags:
        # each opening must have exactly one matching close, none contributed by data.
        template_closes = {tag: len(re.findall('(?i)' + re.escape(tag), TEMPLATE)) for tag in ('</script', '</style')}
        for tag, expected in template_closes.items():
            found = len(re.findall('(?i)' + re.escape(tag), html_out))
            self.assertEqual(expected, found, f'the staged bundle contributed a {tag}')
        self.assertNotIn('<!--', html_out.split('</head>')[-1])
        self.assertIn(FROZEN_CSP, html_out)


class FieldValidation(unittest.TestCase):
    """Finding 1b and 3: types, control characters and length caps on display fields."""

    def test_S01_string_table_line_rejected(self):
        data = fixture()
        data['tables'][0]['line'] = '<img src=x onerror=alert(1)>'
        with self.assertRaises(ValueError):
            normalize(data)

    def test_S01_negative_and_boolean_line_rejected(self):
        for bad in (-1, True, 1.5, {'x': 1}):
            data = fixture()
            data['tables'][0]['line'] = bad
            with self.assertRaises(ValueError):
                normalize(data)

    def test_S01_integer_line_preserved(self):
        self.assertEqual(normalize(fixture())['tables'][0]['line'], 12)

    def test_S01_non_string_display_fields_rejected(self):
        for field in ('className', 'domain', 'type', 'name'):
            data = fixture()
            data['tables'][0][field] = 12345
            with self.assertRaises(ValueError, msg=f'{field} accepted a non-string'):
                normalize(data)

    def test_S01_non_string_project_name_rejected(self):
        data = fixture()
        data['project']['name'] = 42
        with self.assertRaises(ValueError):
            normalize(data)

    def test_S01_non_string_column_type_rejected(self):
        # buildFindings() calls type.toUpperCase() at load, so a non-string blanked the page.
        data = fixture()
        data['tables'][0]['allColumns'][1]['type'] = 7
        with self.assertRaises(ValueError):
            normalize(data)

    def test_S01_control_characters_stripped_from_display_fields(self):
        data = fixture()
        data['tables'][0]['className'] = 'Item\x00\x07Name'
        self.assertEqual(normalize(data)['tables'][0]['className'], 'ItemName')

    def test_S01_over_length_identifier_rejected(self):
        data = fixture()
        data['tables'][0]['className'] = 'x' * (NAME_CAP + 1)
        with self.assertRaises(ValueError):
            normalize(data)

    def test_S01_definition_keeps_newlines_and_tabs(self):
        data = fixture()
        data['tables'][0]['definition'] = 'SELECT 1\n\tFROM t'
        self.assertEqual(normalize(data)['tables'][0]['definition'], 'SELECT 1\n\tFROM t')

    def test_S01_definition_cap_is_larger_than_the_name_cap(self):
        self.assertGreater(TEXT_CAP, NAME_CAP)


class ContractVersion(unittest.TestCase):
    """Finding 7: the contract gains a version with a compatibility rule."""

    def test_S01_contract_version_defaults(self):
        self.assertEqual(normalize(fixture())['contractVersion'], CONTRACT_VERSION)

    def test_S01_contract_version_minor_accepted(self):
        data = fixture()
        data['contractVersion'] = CONTRACT_VERSION.split('.')[0] + '.9'
        self.assertEqual(normalize(data)['contractVersion'], CONTRACT_VERSION.split('.')[0] + '.9')

    def test_S01_contract_version_major_mismatch_rejected(self):
        data = fixture()
        data['contractVersion'] = '99.0'
        with self.assertRaises(ValueError):
            normalize(data)

    def test_S01_contract_version_must_be_numeric(self):
        data = fixture()
        data['contractVersion'] = 'one'
        with self.assertRaises(ValueError):
            normalize(data)


class HostileFixture(unittest.TestCase):
    """The hostile fixture must normalise and render inert."""

    def setUp(self):
        self.path = ROOT.parent / 'fixtures/schemas/hostile.json'
        if not self.path.is_file():
            self.skipTest('fixtures/schemas/hostile.json is not present')

    def test_S01_hostile_fixture_still_normalizes(self):
        normalize(json.loads(self.path.read_text(encoding='utf-8')))

    def test_S01_hostile_fixture_renders_without_live_markup(self):
        # Escaped hostile text still contains the substring "onerror=", so assert on the
        # live forms: no element the template does not itself define, and no early close.
        out = render(json.loads(self.path.read_text(encoding='utf-8')))
        self.assertNotIn('<img', out, 'a hostile value produced a live <img> element')
        self.assertNotIn('<script>alert', out)
        # A bare 'javascript:' substring is inert inside the JSON data island and inside
        # React's own URL-blocking code. What would be live is one in a URL attribute.
        url_attribute_scheme = re.compile(
            r'(?:href|src|action|formaction)\s*=\s*[' + '"' + "'" + r']?\s*javascript:', re.I)
        self.assertEqual([], url_attribute_scheme.findall(out))
        # Data must contribute no closing tag. Opening tags are not the invariant: the
        # React bundle legitimately carries the string "<script><\\/script>", whose close
        # script_safe has already neutralised, so opens in the output exceed the
        # template's while closes must match it exactly.
        for tag in ('</script', '</style'):
            pattern = re.compile('(?i)' + re.escape(tag))
            self.assertEqual(
                len(pattern.findall(TEMPLATE)), len(pattern.findall(out)),
                f'data contributed a {tag} and could close the element early',
            )
        # And the value did reach the page, escaped rather than dropped.
        self.assertIn('&lt;img', out, 'the hostile value was not rendered at all')
        self.assertIn(FROZEN_CSP, out)


if __name__ == '__main__':
    unittest.main()
