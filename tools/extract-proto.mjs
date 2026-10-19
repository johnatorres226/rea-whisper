// Reconstruct .proto definitions from a protobuf-ts webpack bundle.
// Usage: node extract-proto.mjs <bundle.js> <pkg.prefix.> > out.proto
// Finds `class extends MessageType { constructor(){ super("pkg.Name", [fields]) } }`
// and `new ServiceType("pkg.Svc", [methods])`, resolving T: () => ident via scope.
import fs from "node:fs";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default;

const [file, prefix] = process.argv.slice(2);
if (!file || !prefix) { console.error("usage: extract-proto.mjs <bundle.js> <pkg.prefix.>"); process.exit(2); }
const ast = parse(fs.readFileSync(file, "utf8"), { sourceType: "script", errorRecovery: true });

const SCALAR = { 1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32", 6: "fixed64", 7: "fixed32",
  8: "bool", 9: "string", 12: "bytes", 13: "uint32", 15: "sfixed32", 16: "sfixed64", 17: "sint32", 18: "sint64" };

const messages = new Map(); // typeName -> fields[]
const enums = new Map(); // typeName -> [[name, value]]
const services = new Map(); // typeName -> methods[]
const msgNodes = new Map(); // AST node of `new (class…)()` init -> typeName

const lit = (n) => n && (n.type === "StringLiteral" || n.type === "NumericLiteral" || n.type === "BooleanLiteral") ? n.value
  : n && n.type === "UnaryExpression" && n.operator === "!" && n.argument.type === "NumericLiteral" ? !n.argument.value : undefined;
const prop = (obj, key) => obj.properties.find((p) => p.key && (p.key.name === key || p.key.value === key))?.value;

// Pass 1: message classes.
traverse(ast, {
  CallExpression(path) {
    const { node } = path;
    if (node.callee.type !== "Super") return;
    const [name, arr] = node.arguments;
    if (name?.type !== "StringLiteral" || !/^[a-z_]+(\.[a-z0-9_]+)*\.[A-Z]\w*$/.test(name.value) || arr?.type !== "ArrayExpression") return;
    const newExpr = path.findParent((p) => p.isNewExpression());
    if (newExpr) msgNodes.set(newExpr.node, name.value);
    if (name.value.startsWith(prefix)) messages.set(name.value, { path, fields: arr.elements });
  },
});

// Resolve `T: () => ident` (or array form for enums) to a type name.
function resolveIdent(path, ident) {
  const b = path.scope.getBinding(ident);
  const init = b?.path.node.init;
  return init ? msgNodes.get(init) : undefined;
}
// Webpack module table: `12345(e, t, n) { … }` methods keyed by numeric id.
const modules = new Map();
traverse(ast, { ObjectMethod(p) { if (p.node.key.type === "NumericLiteral") modules.set(p.node.key.value, p); } });

// Follow `ns.Export` where `ns = n(<moduleId>)` and the module does `n.d(t, { Export: () => local })`.
function crossModule(path, member) {
  const init = path.scope.getBinding(member.object.name)?.path.node.init;
  const mod = init?.type === "CallExpression" && modules.get(init.arguments[0]?.value);
  let found;
  mod?.traverse({
    CallExpression(c) {
      const [, exp] = c.node.arguments;
      if (c.node.callee.property?.name !== "d" || exp?.type !== "ObjectExpression") return;
      const getter = prop(exp, member.property.name);
      if (getter?.body?.type === "Identifier") found = [c, getter.body.name];
    },
  });
  return found;
}

function enumValues(path, ident) {
  if (typeof ident !== "string") [path, ident] = crossModule(path, ident) ?? [path, ""];
  const b = path.scope.getBinding(ident);
  if (!b) return [];
  const vals = [];
  // TS-enum IIFE: `X = (function(e){…})({})` or `(function(e){…})(X || (X = {}))`
  const calls = [b.path.get("init"), ...b.referencePaths.filter((r) => r.parentPath.isLogicalExpression()
    && r.parentPath.parentPath.isCallExpression()).map((r) => r.parentPath.parentPath)];
  for (const call of calls) {
    const fn = call?.node?.callee;
    if (!call.isCallExpression?.() || !fn || (fn.type !== "FunctionExpression" && fn.type !== "ArrowFunctionExpression")) continue;
    call.get("callee").traverse({
      AssignmentExpression(a) {
        const l = a.node.left, r = a.node.right; // e[(e.NAME = 0)] = "NAME"
        if (l.type === "MemberExpression" && l.computed && l.property.type === "AssignmentExpression"
          && r.type === "StringLiteral") vals.push([r.value, lit(l.property.right) ?? l.property.right.argument?.value * -1]);
      },
    });
    if (vals.length) break;
  }
  return vals;
}

function typeOf(path, f) {
  const kind = lit(prop(f, "kind"));
  const T = prop(f, "T");
  const body = T?.type === "ArrowFunctionExpression" ? T.body : T;
  if (kind === "scalar") return SCALAR[lit(T)] ?? `scalar_${lit(T)}`;
  if (kind === "message") return resolveIdent(path, body.name) ?? `?${body.name}`;
  if (kind === "enum") {
    const [n, obj, pfx] = body.elements;
    if (!enums.has(n.value)) enums.set(n.value, { pfx: lit(pfx) ?? "", vals: enumValues(path, obj.type === "Identifier" ? obj.name : obj) });
    return n.value;
  }
  if (kind === "map") {
    const K = SCALAR[lit(prop(f, "K"))];
    const V = prop(f, "V");
    return `map<${K}, ${typeOf(path, V)}>`;
  }
  return `?${kind}`;
}

// Pass 2: services (constructed with `new ServiceType("pkg.Svc", [...])`).
traverse(ast, {
  "CallExpression|NewExpression"(path) {
    const { node } = path;
    const [name, arr] = node.arguments;
    if (node.callee.type === "Super" || name?.type !== "StringLiteral" || !name.value.startsWith(prefix)
      || arr?.type !== "ArrayExpression" || !arr.elements.every((e) => e?.type === "ObjectExpression" && prop(e, "I"))) return;
    services.set(name.value, arr.elements.map((m) => ({
      name: lit(prop(m, "name")),
      I: msgNodes.get(path.scope.getBinding(prop(m, "I").name)?.path.node.init),
      O: msgNodes.get(path.scope.getBinding(prop(m, "O").name)?.path.node.init),
      cs: lit(prop(m, "clientStreaming")) === true, ss: lit(prop(m, "serverStreaming")) === true,
    })));
  },
});

const short = (t) => t.startsWith(prefix) ? t.slice(prefix.length) : t;
const out = [`syntax = "proto3";`, `package ${prefix.replace(/\.$/, "")};`, `import "google/protobuf/duration.proto";`, ""];
for (const [svc, methods] of services) {
  out.push(`service ${short(svc)} {`);
  for (const m of methods) out.push(`  rpc ${m.name}(${m.cs ? "stream " : ""}${short(m.I)}) returns (${m.ss ? "stream " : ""}${short(m.O)});`);
  out.push("}", "");
}
for (const [name, { path, fields }] of [...messages].sort()) {
  out.push(`message ${short(name)} {`);
  const oneofs = new Map();
  for (const f of fields) {
    const line = { no: lit(prop(f, "no")), name: lit(prop(f, "name")), type: short(typeOf(path, f)),
      rep: prop(f, "repeat") ? "repeated " : lit(prop(f, "opt")) ? "optional " : "" };
    const oneof = lit(prop(f, "oneof"));
    if (oneof) { if (!oneofs.has(oneof)) oneofs.set(oneof, []); oneofs.get(oneof).push(line); continue; }
    out.push(`  ${line.rep}${line.type.replace(/map<(\w+), (.+)>/, (_, k, v) => `map<${k}, ${short(v)}>`)} ${line.name} = ${line.no};`);
  }
  for (const [o, ls] of oneofs) {
    out.push(`  oneof ${o} {`);
    for (const l of ls) out.push(`    ${l.type} ${l.name} = ${l.no};`);
    out.push("  }");
  }
  out.push("}", "");
}
for (const [name, { pfx, vals }] of [...enums].sort()) {
  out.push(`enum ${short(name)} {`);
  for (const [n, v] of vals) out.push(`  ${pfx}${n} = ${v};`);
  out.push("}", "");
}
process.stdout.write(out.join("\n"));
console.error(`messages=${messages.size} enums=${enums.size} services=${services.size}`);
