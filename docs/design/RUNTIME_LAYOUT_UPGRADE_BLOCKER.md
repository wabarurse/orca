# Runtime layout upgrade boundary — resolved by operator-controlled downtime

The earlier investigation at `04438b1` identified a real limitation: a new
version marker cannot stop an old executable or source checkout from launching.
The user accepted a manually executed migration under coordinated offline
exclusion of all participants and old launches, including after migration.

The implementation and operator steps are now in [Orca home](../ORCA_HOME.md)
and `scripts/migrate-layout.ts`. Acknowledgement is not technical exclusion.
The script refuses unresolved locks and mixed layouts; startup gates the new
version only. Bin-local installer coordination remains in place. No live home
migration, installation, restart or deployment was performed during development.
