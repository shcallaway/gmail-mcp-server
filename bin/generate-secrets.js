#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const envExamplePath = path.join(projectRoot, '.env.example');

// Colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(msg) {
  console.log(msg);
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase());
    });
  });
}

// Generate secrets
const TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const JWT_SECRET = crypto.randomBytes(48).toString('base64');

log('\nGenerated secrets:\n');
log(`${colors.cyan}TOKEN_ENCRYPTION_KEY${colors.reset}=${TOKEN_ENCRYPTION_KEY}`);
log(`${colors.cyan}JWT_SECRET${colors.reset}=${JWT_SECRET}`);
log('');

async function main() {
  // Check if .env exists
  if (fs.existsSync(envPath)) {
    const answer = await prompt('Append to existing .env file? (y/N) ');
    if (answer === 'y' || answer === 'yes') {
      let content = fs.readFileSync(envPath, 'utf-8');

      // Check if secrets already exist
      if (content.includes('TOKEN_ENCRYPTION_KEY=') || content.includes('JWT_SECRET=')) {
        const overwrite = await prompt('Secrets already exist in .env. Overwrite? (y/N) ');
        if (overwrite === 'y' || overwrite === 'yes') {
          // Replace existing values
          content = content.replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, `TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}`);
          content = content.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${JWT_SECRET}`);
          fs.writeFileSync(envPath, content);
          log(`${colors.green}Updated secrets in .env${colors.reset}`);
        } else {
          log('Skipped.');
        }
      } else {
        // Append new secrets
        const addition = `\n# Generated secrets\nTOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}\nJWT_SECRET=${JWT_SECRET}\n`;
        fs.appendFileSync(envPath, addition);
        log(`${colors.green}Added secrets to .env${colors.reset}`);
      }
    } else {
      log('Skipped.');
    }
  } else if (fs.existsSync(envExamplePath)) {
    const answer = await prompt('Create .env from .env.example with these secrets? (y/N) ');
    if (answer === 'y' || answer === 'yes') {
      let content = fs.readFileSync(envExamplePath, 'utf-8');

      // Replace placeholder values
      content = content.replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, `TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}`);
      content = content.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${JWT_SECRET}`);

      fs.writeFileSync(envPath, content);
      log(`${colors.green}Created .env with secrets.${colors.reset}`);
      log(`${colors.dim}Edit it to add your Google OAuth credentials.${colors.reset}`);
    } else {
      log('Skipped.');
    }
  } else {
    log(`${colors.yellow}No .env or .env.example found.${colors.reset}`);
    log('Copy the secrets above into your environment configuration.');
  }

  log('');
}

main().catch(console.error);
