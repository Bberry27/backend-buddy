# snapshots

Optional. The normal way to load a database is the **admin area**: run `npm run up`,
open http://127.0.0.1:8080/, add a connection, and populate its structure. Credentials
are entered in the browser and encrypted on disk; nothing here is required.

This directory exists for a snapshot you already have as a JSON file. Drop it in and it
is pre-rendered when the container starts, so the explorer is available before you add
a connection. With more than one file the first by name wins; name a specific one with
`RMSR_SCHEMA=/snapshots/production.json`.

To produce one outside the admin area, for scripting or continuous integration:

```sh
export RMSR_PG_DSN="host=myserver.postgres.database.azure.com port=5432 \n    dbname=mydb user=readonly_user password=... sslmode=verify-full"

python scripts/introspect_pg.py --dsn-env RMSR_PG_DSN \n    --output snapshots/mine.json --schemas public
```

That reads catalog metadata only: tables, views, columns, keys, constraints, indexes and
declared foreign keys. It issues no query against your tables, so no row, value, minimum
or maximum is read, and row counts are absent rather than estimated. Measured statistics
are a separate, deliberate step.

**Nothing in this directory is committed.** The ignore rule excludes everything except
itself and this README, because a snapshot describes a real schema.
