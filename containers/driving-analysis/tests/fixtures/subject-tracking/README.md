# Subject-tracking fixtures

The five original JSON files in this directory are exact-text test inputs. Their
two-space layout and trailing newlines are intentionally stable so byte comparisons
and literal test mutations do not change when repository formatting runs.

The root `biome.json` disables formatting only for these named files. The Python
contract suite records each file's SHA-256 digest, so an intentional fixture
change must update its tests and expected digest together. Run the full Python
quality gate after any such change.

## Shared deterministic measurement

`deterministic-measurement.json` extends the accepted observations fixture with
the pinned frame manifest, subject seed, directed gates, and literal expected
measurement results. Cases cover complete crossings, an open gap, multiple passes
with tied and slower ranks, and a missing prepared frame.

Python strictly validates and round-trips only observation and gap contracts.
TypeScript runs those contracts through the production measurement engine and
compares every output field with the checked-in expectations. The complete case
also drives bounded R2 reads and the atomic D1 evidence commit, adapting only
authority identity, provenance, and the enclosing test race window.

Expected timestamps and ranks are hand-specified fixture values, never generated
by the measurement engine. The three complete passes enter at 150, 450, and 750
ms and exit at 250, 550, and 1000 ms; durations are 100, 100, and 250 ms. At ten
frames per second, the first two tie and the final pass receives rank two.
