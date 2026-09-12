"""Optional metadata profiling job; input data access uses an explicit read-only connection."""
import argparse
import json
import os
from pathlib import Path
from schema_profiler import connect_readonly, profile
from snapshot_io import validate_output


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--schema', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--dialect', required=True, choices=['sqlite', 'postgresql'])
    p.add_argument('--database')
    p.add_argument('--dsn-env')
    p.add_argument('--tables', nargs='*')
    p.add_argument('--limit', type=int, default=10000)
    p.add_argument('--include-sample-values', action='store_true')
    args = p.parse_args()
    dsn = args.database if args.dialect == 'sqlite' else os.environ.get(args.dsn_env or '')
    if not dsn:
        p.error('An explicit --database or --dsn-env with a value is required')
    try:
        validate_output(args.output, [args.schema, args.database if args.dialect == 'sqlite' else None])
        graph = json.loads(args.schema.read_text(encoding='utf-8-sig'))
        with connect_readonly(args.dialect, dsn) as connection:
            result = profile(graph, connection, args.tables or [t['id'] for t in graph['tables']], max_rows=args.limit, include_sample_values=args.include_sample_values)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result['graph'], indent=2), encoding='utf-8')
    except Exception:
        p.exit(2, 'Read-only profiling failed. Check the selected connection, source, output paths, and operation limits.\n')
    print(json.dumps({'output': str(args.output.resolve()), 'limit': result['limit'], 'tables': len(args.tables or graph['tables'])}))


if __name__ == '__main__':
    main()
