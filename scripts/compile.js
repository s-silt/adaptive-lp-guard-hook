const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const NODE_MODULES = path.join(ROOT, "node_modules");
const OUT_DIR = path.join(ROOT, "build", "artifacts");

function collectSources(dir, sources, relRoot) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, sources, relRoot);
    } else if (entry.name.endsWith(".sol")) {
      const sourceName = path.relative(relRoot, full).split(path.sep).join("/");
      sources[sourceName] = { content: fs.readFileSync(full, "utf8") };
    }
  }
}

function importCallback(importPath) {
  let candidate;
  if (importPath.startsWith("@") || importPath.includes("/")) {
    candidate = path.join(NODE_MODULES, importPath);
  } else {
    candidate = path.join(CONTRACTS_DIR, importPath);
  }
  if (fs.existsSync(candidate)) {
    return { contents: fs.readFileSync(candidate, "utf8") };
  }
  return { error: "File not found: " + importPath };
}

function compile() {
  const sources = {};
  collectSources(CONTRACTS_DIR, sources, ROOT);

  const input = {
    language: "Solidity",
    sources,
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"]
        }
      }
    }
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: importCallback })
  );

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error(`Compilation failed with ${errors.length} error(s)`);
  }

  const warnings = (output.errors || []).filter((e) => e.severity === "warning");
  for (const w of warnings) {
    if (!w.message.includes("Source file does not specify required compiler")) {
      console.warn(w.formattedMessage || w.message);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let count = 0;
  for (const [sourceName, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, artifact] of Object.entries(contracts)) {
      if (!artifact.evm || !artifact.evm.bytecode || !artifact.evm.bytecode.object) continue;
      if (artifact.evm.bytecode.object.length === 0) continue;
      const out = {
        contractName: name,
        sourceName,
        abi: artifact.abi,
        bytecode: "0x" + artifact.evm.bytecode.object,
        deployedBytecode: "0x" + artifact.evm.deployedBytecode.object
      };
      fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(out, null, 2));
      count++;
    }
  }

  console.log(`Compiled ${count} contract(s) into ${path.relative(ROOT, OUT_DIR)}`);
  return output;
}

if (require.main === module) {
  compile();
}

module.exports = { compile };
