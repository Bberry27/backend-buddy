"""Tests for ``services/api``. A package so ``unittest discover`` collects them from any start
directory, and so a later ``scripts/project.mjs`` step can point discovery at
``services/api/tests``.

The database suites need ``BB_TEST_DATABASE_URL``; see ``conftest_db.py`` for the one-line
``docker run`` that provides it.
"""
