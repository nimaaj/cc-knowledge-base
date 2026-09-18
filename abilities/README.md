# Ability manifest format

Abilities are versioned, data-only wrappers around executables. The daemon never invokes them through a shell, and every invocation creates a normal command approval.

```json
{
  "manifestVersion": 1,
  "id": "say-hello",
  "name": "Say hello",
  "description": "Print a greeting",
  "inputSchema": {
    "type": "object",
    "properties": { "name": { "type": "string" } },
    "required": ["name"]
  },
  "execution": {
    "kind": "command",
    "executable": "printf",
    "args": ["Hello %s\\n", "${input.name}"],
    "timeoutMs": 10000
  }
}
```

`${input.field}` placeholders are substituted inside individual executable/argument strings; they are never shell-expanded. Install with `pnpm cca ability install path/to/ability.json`.

The v1 runtime validates the JSON Schema object fields `type`, `properties`, `required`, and `additionalProperties`. Keep manifests within that subset for portable validation.
