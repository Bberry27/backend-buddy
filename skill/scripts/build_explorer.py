"""Validate canonical schema JSON and render a portable, offline explorer."""
import argparse
import copy
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Supported contract version (schema-graph-contract.md B1). A document without the field is v1.
CONTRACT_VERSION = '1.0'
# Display-text caps, recorded in docs/reference/limits-and-caps.md section A5. An over-length value
# is rejected, never truncated, so an identifier is never silently altered before it is rendered.
NAME_CAP = 256
TEXT_CAP = 4096
# NUL, C0 controls, DEL, and the bidi overrides and isolates U+202A-U+202E and U+2066-U+2069.
CONTROL_CHARACTERS = re.compile(r'[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]')
# Free-text fields keep newlines and tabs; every other character above is still stripped.
MULTILINE_CONTROL_CHARACTERS = re.compile(r'[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]')


def boolean(value):
    if value in (True, 'True', 'true', 1):
        return True
    if value in (False, 'False', 'false', 0, '', None):
        return False
    raise ValueError(f'Invalid boolean: {value!r}')


def _text(value, field, *, cap=NAME_CAP, multiline=False):
    """Validate one display string: string type, control characters stripped, length capped."""
    if not isinstance(value, str):
        raise ValueError(f'{field} must be a string, not {type(value).__name__}')
    cleaned = (MULTILINE_CONTROL_CHARACTERS if multiline else CONTROL_CHARACTERS).sub('', value)
    if len(cleaned) > cap:
        raise ValueError(f'{field} exceeds the {cap}-character cap ({len(cleaned)} characters)')
    return cleaned


def _identifier(value, field):
    """An identifier keeps every character it carries; only the length cap is added."""
    if len(value) > NAME_CAP:
        raise ValueError(f'{field} exceeds the {NAME_CAP}-character cap ({len(value)} characters)')
    return value


def _line_number(value, field):
    """A source line is a non-negative integer; a boolean is not an integer here."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f'{field}: line must be a non-negative integer, not {value!r}')
    return value


def normalize(raw):
    data = copy.deepcopy(raw)
    version = _text(data.setdefault('contractVersion', CONTRACT_VERSION), 'contractVersion', cap=32)
    if not re.fullmatch(r'\d+(?:\.\d+)*', version):
        raise ValueError(f'contractVersion must be MAJOR.MINOR, not {version!r}')
    if version.split('.')[0] != CONTRACT_VERSION.split('.')[0]:
        raise ValueError(f'contractVersion {version} is not compatible with contract version {CONTRACT_VERSION}')
    data['contractVersion'] = version
    project = data.get('project', {})
    if not project.get('name') or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project.get('key', '')):
        raise ValueError('project.name and a stable lowercase project.key are required')
    project['name'] = _text(project['name'], 'project.name')
    if not project['name']:
        raise ValueError('project.name and a stable lowercase project.key are required')
    project.setdefault('dialect', 'unknown')
    if not isinstance(data.get('tables'), list) or not isinstance(data.get('links'), list):
        raise ValueError('tables and links must be arrays')
    source = data.setdefault('source', {})
    for key, default in {'file': 'Source not recorded', 'commit': 'unversioned', 'sha256': 'Not recorded', 'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'basis': 'Source coverage not specified by adapter; not verified against a live database.'}.items():
        source.setdefault(key, default)
    for key, cap in {'file': TEXT_CAP, 'commit': NAME_CAP, 'sha256': NAME_CAP, 'generated': NAME_CAP, 'basis': TEXT_CAP}.items():
        source[key] = _text(source[key], f'source.{key}', cap=cap, multiline=key == 'basis')
    by_id = {}
    for t in data['tables']:
        if not isinstance(t.get('id'), str) or not t['id'] or t['id'] in by_id:
            raise ValueError('Each table needs a unique nonempty string id')
        _identifier(t['id'], 'Table id')
        by_id[t['id']] = t
        for k, v in {'name': t['id'], 'schema': '', 'className': t['id'], 'domain': 'Unclassified', 'type': 'Unclassified', 'line': 0, 'indexes': [], 'uniques': [], 'checks': []}.items():
            t.setdefault(k, v)
        for field in ('name', 'schema', 'className', 'domain', 'type'):
            t[field] = _text(t[field], f"{t['id']}: {field}")
        t['line'] = _line_number(t['line'], t['id'])
        if 'file' in t:
            t['file'] = _text(t['file'], f"{t['id']}: file", cap=TEXT_CAP)
        if 'definition' in t:
            t['definition'] = _text(t['definition'], f"{t['id']}: definition", cap=TEXT_CAP, multiline=True)
        if not isinstance(t.get('allColumns'), list):
            raise ValueError(f"{t['id']}: allColumns must be an array")
        names = set()
        for c in t['allColumns']:
            if not isinstance(c.get('name'), str) or not c['name'] or c['name'] in names:
                raise ValueError(f"{t['id']}: duplicate or invalid column name")
            _identifier(c['name'], f"{t['id']}: column name")
            names.add(c['name'])
            for k, v in {'type': 'Unknown', 'fk': '', 'line': 0, 'ondelete': '', 'typeBasis': 'Not specified by adapter'}.items():
                c.setdefault(k, v)
            for field in ('type', 'fk', 'ondelete', 'typeBasis'):
                c[field] = _text(c[field], f"{t['id']}.{c['name']}: {field}")
            c['line'] = _line_number(c['line'], f"{t['id']}.{c['name']}")
            if 'file' in c:
                c['file'] = _text(c['file'], f"{t['id']}.{c['name']}: file", cap=TEXT_CAP)
            if 'typeDefinition' in c:
                c['typeDefinition'] = _text(c['typeDefinition'], f"{t['id']}.{c['name']}: typeDefinition", cap=TEXT_CAP, multiline=True)
            for k in ('pk', 'index', 'unique'):
                c[k] = boolean(c.get(k))
            c['nullable'] = '' if c.get('nullable') in (None, '') else str(boolean(c['nullable']))
            if c['unique'] and not any(u['columns'] == [c['name']] for u in t['uniques']):
                t['uniques'].append({'name': 'unique column ' + c['name'], 'columns': [c['name']]})
        primary = t.get('primaryKey', [c['name'] for c in t['allColumns'] if c['pk']])
        if not isinstance(primary, list) or len(primary) != len(set(primary)) or not set(primary).issubset(names):
            raise ValueError(f"{t['id']}: invalid primaryKey")
        t['pk'] = ', '.join(primary)
        t['primaryKey'] = primary
        for c in t['allColumns']:
            c['pk'] = c['name'] in primary
        for kind in ('indexes', 'uniques'):
            for group in t[kind]:
                group.setdefault('name', '')
                group.setdefault('columns', [])
                group['name'] = _text(group['name'], f"{t['id']}: {kind} name")
                for flag in ('unique', 'partial', 'expression'):
                    group[flag] = boolean(group.get(flag))
                if not group['expression'] and not set(group['columns']).issubset(names):
                    raise ValueError(f"{t['id']}: {kind} refers to unknown columns")
        for c in t['checks']:
            c.setdefault('name', 'Unnamed check')
            c.setdefault('definition', 'Not supplied')
            c['name'] = _text(c['name'], f"{t['id']}: checks name")
            c['definition'] = _text(c['definition'], f"{t['id']}: checks definition", cap=TEXT_CAP, multiline=True)
    seen, constraint_groups = set(), {}
    for link in data['links']:
        if link.get('kind') not in ('declared FK', 'inferred by naming'):
            raise ValueError('Relationship kind must distinguish declared FK from inferred by naming')
        for field in ('constraintId', 'name'):
            if field in link:
                link[field] = _text(link[field], f'links[].{field}')
        source_table = by_id.get(link.get('source'))
        source_column = next((c for c in source_table['allColumns'] if c['name'] == link.get('column')), None) if source_table else None
        if not source_column or not link.get('target') or not link.get('targetColumn'):
            raise ValueError('Relationship source column and target identifiers are required')
        target = by_id.get(link['target'])
        target_exists = target and any(c['name'] == link['targetColumn'] for c in target['allColumns'])
        if link['kind'] == 'declared FK' and not target_exists:
            raise ValueError(f"Unresolved declared FK target: {link['target']}.{link['targetColumn']}")
        identity = tuple(link[k] for k in ('source', 'column', 'target', 'targetColumn', 'kind'))
        if identity in seen:
            raise ValueError('Duplicate relationship pair')
        seen.add(identity)
        if link['kind'] == 'declared FK':
            source_column['fk'] = link['target'] + '.' + link['targetColumn']
        if link.get('constraintId'):
            group = constraint_groups.setdefault((link['source'], link['constraintId']), [])
            if group and (group[0]['target'] != link['target'] or group[0]['kind'] != link['kind']):
                raise ValueError('Composite relationship group has inconsistent target or evidence')
            group.append(link)
    declared = {(l['source'], l['column']) for l in data['links'] if l['kind'] == 'declared FK'}
    data['links'] = [l for l in data['links'] if l['kind'] == 'declared FK' or (l['source'], l['column']) not in declared]
    return data


def script_safe(text):
    """Neutralise the sequences that can end an inline <script> element, case-insensitively."""
    return re.sub(r'(?i)</script', r'<\\/script', text).replace('<!--', '<\\!--')


def style_safe(text):
    """Neutralise the same sequences for an inline <style> element, with valid CSS escapes."""
    return re.sub(r'(?i)</style', r'<\\/style', text).replace('<!--', '<\\!--')


def render(raw):
    data = normalize(raw)
    template = (ROOT / 'assets/explorer.html').read_text(encoding='utf-8')
    icons = json.loads((ROOT / 'assets/icons.json').read_text(encoding='utf-8'))
    replacements = {'__PROJECT_HTML__': html.escape(data['project']['name']), '__SCHEMA_DATA__': json.dumps(data, ensure_ascii=True).replace('<', '\\u003c'), '__ICON_DATA__': json.dumps(icons).replace('<', '\\u003c')}
    extensions = ROOT / 'assets/extensions/dist'
    replacements['__EXTENSIONS_JS__'] = script_safe((extensions / 'extensions.js').read_text(encoding='utf-8')) if (extensions / 'extensions.js').exists() else ''
    replacements['__EXTENSIONS_CSS__'] = style_safe((extensions / 'extensions.css').read_text(encoding='utf-8')) if (extensions / 'extensions.css').exists() else ''
    # One pass prevents placeholder-like user data from becoming template syntax.
    return re.sub(r'__PROJECT_HTML__|__SCHEMA_DATA__|__ICON_DATA__|__EXTENSIONS_JS__|__EXTENSIONS_CSS__', lambda m: replacements[m.group()], template)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--schema', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.schema.resolve() == args.output.resolve():
        parser.error('Input and output must be different files')
    raw = json.loads(args.schema.read_text(encoding='utf-8-sig'))
    output = render(raw)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output, encoding='utf-8')
    print(json.dumps({'output': str(args.output.resolve()), 'tables': len(raw['tables']), 'columns': sum(len(t['allColumns']) for t in raw['tables'])}))


if __name__ == '__main__':
    main()
