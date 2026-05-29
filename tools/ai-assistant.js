#!/usr/bin/env node
const fs = require('fs').promises;
const { existsSync } = require('fs');
const path = require('path');

const supportedExtensions = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.html', '.css', '.md', '.env', '.txt', '.yml', '.yaml'
]);
const ignoreNames = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.idea', '.vscode']);
const DEFAULT_MODEL = 'gpt-3.5-turbo';
const MAX_TOKENS = 1000;

function printHelp() {
  console.log(`Usage: npm run assistant -- [options]

Options:
  --file <path>      Analyze a single file
  --dir <path>       Analyze a directory recursively
  --backend          Analyze only the backend folder
  --all              Analyze both frontend and backend folders
  --model <name>     OpenAI model (default: ${DEFAULT_MODEL})
  --help             Show this help message

Examples:
  npm run assistant -- --file frontend/public/app.js
  npm run assistant -- --dir backend
  npm run assistant -- --backend
  npm run assistant -- --all
`);
}

function parseArgs(argv) {
  const options = { file: null, dir: null, backend: false, all: false, model: DEFAULT_MODEL };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--file':
        options.file = argv[++i];
        break;
      case '--dir':
        options.dir = argv[++i];
        break;
      case '--backend':
        options.backend = true;
        break;
      case '--all':
        options.all = true;
        break;
      case '--model':
        options.model = argv[++i];
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        options.invalid = true;
        break;
    }
  }

  return options;
}

function parseEnvContents(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadEnvFile(filePath) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    const parsed = parseEnvContents(contents);
    Object.keys(parsed).forEach((key) => {
      if (!process.env[key]) {
        process.env[key] = parsed[key];
      }
    });
  } catch (error) {
    // ignore missing env files
  }
}

async function ensureApiKey() {
  if (process.env.OPENAI_API_KEY) return;
  await loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (process.env.OPENAI_API_KEY) return;
  await loadEnvFile(path.resolve(process.cwd(), 'backend', '.env'));
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'Missing OPENAI_API_KEY. Set it in your shell environment or add OPENAI_API_KEY to a .env file in the repo root or backend folder.'
    );
  }
}

function isValidFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return supportedExtensions.has(extension);
}

async function collectFiles(targetPath) {
  const files = [];
  const stats = await fs.stat(targetPath);

  if (stats.isFile()) {
    if (isValidFile(targetPath)) {
      files.push(targetPath);
    }
    return files;
  }

  if (!stats.isDirectory()) {
    return files;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryName = entry.name;
      if (ignoreNames.has(entryName)) return;
      const fullPath = path.join(targetPath, entryName);
      if (entry.isDirectory()) {
        const nested = await collectFiles(fullPath);
        files.push(...nested);
      } else if (entry.isFile() && isValidFile(fullPath)) {
        files.push(fullPath);
      }
    })
  );

  return files;
}

async function callOpenAI(messages, model) {
  if (typeof fetch !== 'function') {
    throw new Error('Node fetch API is unavailable. Use Node 18 or newer.');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function analyzeFile(filePath, model) {
  const content = await fs.readFile(filePath, 'utf8');
  const relativePath = path.relative(process.cwd(), filePath);
  const pathSegments = relativePath.split(path.sep);
  const isBackendFile = pathSegments[0] === 'backend';

  console.log(`\n=== Reviewing: ${relativePath} ===`);

  const systemPrompt = isBackendFile
    ? 'You are an expert Node.js backend developer. Review the file for backend-specific issues, including security, authentication, database access, API routing, environment config, and server logic.'
    : 'You are a skilled Node.js and web developer assistant. Review the provided source file and deliver a concise summary, bug/security observations, and practical suggestions.';

  const userPrompt = isBackendFile
    ? 'Review this backend file as a whole and explain its behavior. Focus on backend-specific problems, architecture, security, database use, authentication, and integration with the frontend. Do not invent missing context.\n\n' +
      'File path: ' + relativePath + '\n\n' +
      '```\n' +
      content +
      '\n```'
    : 'Review this file as a whole and explain its behavior. Focus on backend/frontend integration, potential issues, and improvements. Do not invent missing context.\n\n' +
      'File path: ' + relativePath + '\n\n' +
      '```\n' +
      content +
      '\n```';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  return await callOpenAI(messages, model);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.invalid) {
    printHelp();
    if (options.invalid) process.exit(1);
    return;
  }

  if (!options.file && !options.dir && !options.backend && !options.all) {
    options.all = true;
  }

  await ensureApiKey();

  const targets = [];
  if (options.file) {
    targets.push(path.resolve(process.cwd(), options.file));
  } else if (options.dir) {
    targets.push(path.resolve(process.cwd(), options.dir));
  } else if (options.backend) {
    targets.push(path.resolve(process.cwd(), 'backend'));
  } else if (options.all) {
    targets.push(path.resolve(process.cwd(), 'backend'));
    targets.push(path.resolve(process.cwd(), 'frontend'));
  }

  let files = [];

  for (const target of targets) {
    if (!existsSync(target)) {
      console.warn(`Warning: target path does not exist: ${target}`);
      continue;
    }
    const collected = await collectFiles(target);
    files.push(...collected);
  }

  if (files.length === 0) {
    console.error('No supported source files were found for analysis.');
    process.exit(1);
  }

  for (const file of files) {
    try {
      const result = await analyzeFile(file, options.model);
      console.log(result.trim());
    } catch (error) {
      console.error(`Failed to analyze ${file}: ${error.message}`);
    }
  }
}

run().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
