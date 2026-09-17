# Tracking digest compatibility

`tracking-python-canonical.json` records CPython `json.dumps` bytes and SHA-256
results for the existing Tracking provenance and input formats. Both the
TypeScript publication suite and Python tracking suite exercise their production
hashing paths against these checked-in values. Provenance has no trailing newline;
Tracking input has exactly one. Float fields retain Python float semantics,
including negative zero. The cases cover scientific-notation boundaries and
adjacent binary64 values, subnormal values, valid seed boxes, and Unicode.

These fixtures do not change the separately versioned Inference-profile format.
