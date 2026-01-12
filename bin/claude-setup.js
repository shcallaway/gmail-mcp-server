#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paths
const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json');
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const LOCAL_SKILLS_DIR = path.join(__dirname, '..', '.claude', 'skills');
const MCP_SERVER_URL = 'http://localhost:3000/mcp';
const MCP_SERVER_NAME = 'gmail-mcp';
const SKILL_PREFIX = 'gmail-';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(msg) {
  console.log(msg);
}

function success(msg) {
  console.log(`${colors.green}  + ${msg}${colors.reset}`);
}

function removed(msg) {
  console.log(`${colors.red}  - ${msg}${colors.reset}`);
}

function info(msg) {
  console.log(`${colors.dim}  ${msg}${colors.reset}`);
}

function header(msg) {
  console.log(`\n${colors.cyan}${msg}${colors.reset}`);
}

// Read Claude config file
function readClaudeConfig() {
  if (!fs.existsSync(CLAUDE_CONFIG)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf-8'));
  } catch {
    return {};
  }
}

// Write Claude config file
function writeClaudeConfig(config) {
  fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2) + '\n');
}

// Check if MCP server is installed
function isMcpServerInstalled() {
  const config = readClaudeConfig();
  return config.mcpServers?.[MCP_SERVER_NAME] !== undefined;
}

// Install MCP server to ~/.claude.json
function installMcpServer() {
  const config = readClaudeConfig();

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const wasInstalled = config.mcpServers[MCP_SERVER_NAME] !== undefined;
  config.mcpServers[MCP_SERVER_NAME] = { url: MCP_SERVER_URL };

  writeClaudeConfig(config);

  if (wasInstalled) {
    info(`Updated ${MCP_SERVER_NAME} in ~/.claude.json`);
  } else {
    success(`Added ${MCP_SERVER_NAME} to ~/.claude.json`);
  }

  return true;
}

// Uninstall MCP server from ~/.claude.json
function uninstallMcpServer() {
  const config = readClaudeConfig();

  if (config.mcpServers?.[MCP_SERVER_NAME]) {
    delete config.mcpServers[MCP_SERVER_NAME];
    writeClaudeConfig(config);
    removed(`Removed ${MCP_SERVER_NAME} from ~/.claude.json`);
    return true;
  }

  info(`${MCP_SERVER_NAME} not found in ~/.claude.json`);
  return false;
}

// Get list of skill files from local directory (returns skill names without .md)
function getLocalSkills() {
  if (!fs.existsSync(LOCAL_SKILLS_DIR)) {
    return [];
  }
  return fs.readdirSync(LOCAL_SKILLS_DIR)
    .filter(f => f.endsWith('.md') && f.startsWith(SKILL_PREFIX))
    .map(f => f.replace('.md', ''));
}

// Get list of installed gmail skill directories
function getInstalledSkills() {
  if (!fs.existsSync(CLAUDE_SKILLS_DIR)) {
    return [];
  }
  return fs.readdirSync(CLAUDE_SKILLS_DIR)
    .filter(f => {
      const skillPath = path.join(CLAUDE_SKILLS_DIR, f);
      const skillFile = path.join(skillPath, 'SKILL.md');
      return f.startsWith(SKILL_PREFIX) &&
             fs.statSync(skillPath).isDirectory() &&
             fs.existsSync(skillFile);
    });
}

// Install skills by creating subdirectories with SKILL.md
function installSkills() {
  const skills = getLocalSkills();

  if (skills.length === 0) {
    info(`No skills found in ${LOCAL_SKILLS_DIR}`);
    return 0;
  }

  // Create skills directory if needed
  if (!fs.existsSync(CLAUDE_SKILLS_DIR)) {
    fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
  }

  let installed = 0;
  for (const skillName of skills) {
    const src = path.join(LOCAL_SKILLS_DIR, `${skillName}.md`);
    const skillDir = path.join(CLAUDE_SKILLS_DIR, skillName);
    const dest = path.join(skillDir, 'SKILL.md');

    // Create skill subdirectory
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    fs.copyFileSync(src, dest);
    success(skillName);
    installed++;
  }

  return installed;
}

// Uninstall skills by removing directories
function uninstallSkills() {
  const skills = getInstalledSkills();

  if (skills.length === 0) {
    info('No Gmail skills found in ~/.claude/skills/');
    return 0;
  }

  let removedCount = 0;
  for (const skillName of skills) {
    const skillDir = path.join(CLAUDE_SKILLS_DIR, skillName);
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed(skillName);
    removedCount++;
  }

  return removedCount;
}

// Show installation status
function showStatus() {
  log('\nGmail MCP - Installation Status\n');

  // MCP Server status
  header('MCP Server');
  if (isMcpServerInstalled()) {
    const config = readClaudeConfig();
    success(`Installed (${config.mcpServers[MCP_SERVER_NAME].url})`);
  } else {
    info('Not installed');
  }

  // Skills status
  header('Skills');
  const installed = getInstalledSkills();
  if (installed.length > 0) {
    success(`${installed.length} skill(s) installed:`);
    for (const skillName of installed) {
      info(`/${skillName}`);
    }
  } else {
    info('No skills installed');
  }

  log('');
}

// Main setup command
function setup() {
  log('\nGmail MCP - Claude Code Setup\n');

  header('MCP Server');
  installMcpServer();

  header('Skills');
  const count = installSkills();

  log(`\n${colors.green}Done!${colors.reset} ${count} skill(s) installed.`);
  log(`\nRun ${colors.cyan}/gmail-inbox${colors.reset} to get started.\n`);
}

// Main uninstall command
function uninstall() {
  log('\nGmail MCP - Uninstall\n');

  header('MCP Server');
  uninstallMcpServer();

  header('Skills');
  const count = uninstallSkills();

  log(`\n${colors.green}Done!${colors.reset} Removed MCP server and ${count} skill(s).\n`);
}

// Parse command and run
const command = process.argv[2] || 'setup';

switch (command) {
  case 'setup':
  case 'install':
    setup();
    break;
  case 'uninstall':
  case 'remove':
    uninstall();
    break;
  case 'status':
    showStatus();
    break;
  default:
    log(`Unknown command: ${command}`);
    log('Usage: node claude-setup.js [setup|uninstall|status]');
    process.exit(1);
}
