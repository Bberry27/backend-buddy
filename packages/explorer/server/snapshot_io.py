from pathlib import Path


def validate_output(output, inputs):
    """Reject aliases to source databases and documents before writing an export."""
    if output is None:
        return
    target = Path(output).resolve()
    for value in inputs:
        if not value:
            continue
        source = Path(value).resolve()
        if target == source or (target.exists() and source.exists() and target.samefile(source)):
            raise ValueError('Snapshot output must be separate from source files')
