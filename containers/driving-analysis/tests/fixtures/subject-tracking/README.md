# Subject-tracking fixtures

The five JSON files in this directory are exact-text test inputs. Their two-space
layout and trailing newlines are intentionally stable so byte comparisons and
literal test mutations do not change when repository formatting runs.

The root `biome.json` disables formatting only for these named files. The Python
contract suite records each file's SHA-256 digest, so an intentional fixture
change must update its tests and expected digest together. Run the full Python
quality gate after any such change.
