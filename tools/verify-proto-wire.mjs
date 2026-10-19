// Validation: cross-check a reconstructed .proto against the bundle's own serializers.
// extract-proto.mjs reads the reflection field lists; this script instead reads every
// `writer.tag(N, WireType.X)` call inside each message's internalBinaryWrite, an
// independent code path, and checks field numbers + wire types agree.
// Usage: node verify-proto-wire.mjs <bundle.js> <file.proto>   (exit 1 on mismatch)
import fs from "node:fs";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default;

const [bundle, protoFile] = process.argv.slice(2);
const ast = parse(fs.readFileSync(bundle, "utf8"), { sourceType: "script", errorRecovery: true });

// 1. Observed: typeName -> Map(fieldNo -> wireTypeName) from internalBinaryWrite bodies.
const observed = new Map();
traverse(ast, {
  ClassMethod(p) {
    if (p.node.key.name !== "constructor") return;
    let typeName;
    p.traverse({ CallExpression(c) {
      if (c.node.callee.type === "Super" && c.node.arguments[0]?.type === "StringLiteral") typeName = c.node.arguments[0].value;
    } });
    if (!typeName?.startsWith("flow_api.v1.")) return;
    const write = p.parentPath.get("body").find((m) => m.node.key?.name === "internalBinaryWrite");
    const tags = new Map();
    write?.traverse({ CallExpression(c) {
      const { callee, arguments: [no, wt] } = c.node;
      if (callee.property?.name === "tag" && no?.type === "NumericLiteral" && wt?.type === "MemberExpression")
        tags.set(no.value, wt.property.name);
    } });
    observed.set(typeName.slice("flow_api.v1.".length), tags);
  },
});

// 2. Expected: wire type implied by each field line of the .proto.
const proto = fs.readFileSync(protoFile, "utf8");
const enumNames = new Set([...proto.matchAll(/^enum (\w+)/gm)].map((m) => m[1]));
const VARINT = /^(u?int(32|64)|sint(32|64)|bool)$/, B32 = /^(float|s?fixed32)$/, B64 = /^(double|s?fixed64)$/;
function wireOf(rep, type) {
  const scalarNumeric = VARINT.test(type) || B32.test(type) || B64.test(type) || enumNames.has(type);
  if (rep === "repeated" && scalarNumeric) return "LengthDelimited"; // proto3 packed
  if (VARINT.test(type) || enumNames.has(type)) return "Varint";
  if (B32.test(type)) return "Bit32";
  if (B64.test(type)) return "Bit64";
  return "LengthDelimited"; // string, bytes, message, map
}
let checked = 0, bad = 0;
for (const [, name, body] of proto.matchAll(/^message (\w+) \{\n([\s\S]*?)^\}/gm)) {
  const tags = observed.get(name);
  if (!tags) { console.log(`MISSING serializer for ${name}`); bad++; continue; }
  const fields = [...body.matchAll(/^\s+(repeated |optional )?(map<[^>]+>|[\w.]+) (\w+) = (\d+);/gm)];
  for (const [, rep, type, field, no] of fields) {
    checked++;
    const exp = wireOf(rep?.trim(), type), got = tags.get(+no);
    if (exp !== got) { console.log(`MISMATCH ${name}.${field}=${no}: proto→${exp} bundle→${got}`); bad++; }
  }
  if (fields.length !== tags.size) { console.log(`COUNT ${name}: proto ${fields.length} fields, bundle writes ${tags.size}`); bad++; }
}
console.log(`checked ${checked} fields across ${observed.size} messages: ${bad ? bad + " problems" : "ALL MATCH"}`);
process.exit(bad ? 1 : 0);
