import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const source = fs.readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8');
const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const anchors = [];
function visit(node) {
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === 'a') anchors.push(node);
  ts.forEachChild(node, visit);
}
visit(file);
const discordLink = anchors.find(node => node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.text === 'href' && prop.initializer?.text === '/workbench-auth/discord/start'));
assert.ok(discordLink, 'Discord login must be an anchor to the root OAuth endpoint, independent of the required Key form');
assert.match(source, /使用 Discord 登录/);
assert.match(source, /或使用 API Key/);
assert.match(source, /useState\(token\s*===\s*DISCORD_SESSION_ACCESS_TOKEN\s*\?\s*""\s*:\s*token\)/,
  'The public session marker must never fill the Key input');
assert.match(source, /<dt>登录方式<\/dt>/);
assert.match(source, /token === DISCORD_SESSION_ACCESS_TOKEN \? 'Discord' : 'API Key'/);
assert.match(source, /canvasProjectScope\(owner, access\.trim\(\), me\.id\)/,
  'Use the bridge real-key identity for Discord canvas restoration');
assert.match(source, /const owner = `\$\{location.origin\}\|\$\{me.id\}`/,
  'Keep the existing gallery/draft owner namespace');
console.log('PASS UI wiring: independent OAuth anchor, API Key form, hidden marker, login method, stable local owner/scope');
