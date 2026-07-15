import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildVerificationMail } from '../src/user_api/verification_mail.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const ignoredDirectories = new Set([
    '.git',
    '.pytest_cache',
    '.venv',
    '.wrangler',
    '__pycache__',
    'coverage',
    'dist',
    'node_modules',
    'playwright-report',
    'target',
    'test-results',
]);
const ignoredLocalFiles = new Set(['wrangler.toml']);
const textExtensions = new Set([
    '', '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.py', '.sh',
    '.toml', '.ts', '.tsx', '.vue', '.yaml', '.yml',
]);

function collectPublicTextFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        if (entry.isFile() && (
            ignoredLocalFiles.has(entry.name)
            || entry.name === '.dev.vars'
            || entry.name.startsWith('.dev.vars.')
        )) continue;
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectPublicTextFiles(absolutePath));
        } else if (
            entry.isFile()
            && textExtensions.has(extname(entry.name).toLowerCase())
            && statSync(absolutePath).size <= 1_000_000
        ) {
            files.push(absolutePath);
        }
    }
    return files;
}

function readRepositoryFile(path) {
    return readFileSync(join(repositoryRoot, path), 'utf8');
}

test('public source contains no private deployment identifiers or example credentials', () => {
    const forbiddenValues = [
        ['mail', 'loven7', 'cc', 'cd'].join('.'),
        ['apimail', 'lmhzeq', 'fun'].join('.'),
        ['loven', 'qzz', 'io'].join('.'),
        ['loven7', 'com'].join('.'),
        ['linux', 'domail'].join(''),
        ['cloudmail', 'webmail'].join('-'),
        ['loven7', 'mail', 'pwa'].join('-'),
        ['TEMP_MAIL_RESEND_TOKEN', 'LOVEN7_COM'].join('_'),
        ['TEMP_MAIL_RESEND_TOKEN', 'LMHZEQ_FUN'].join('_'),
        ['C:', 'Users', 'lin15'].join('\\'),
        ['D:', 'files', 'Aitest4'].join('\\'),
        ['e2192fa1', '3ea1', '4357', 'b5b1', 'fc748f88c90f'].join('-'),
        ['daf84327', 'e65089440b7f88f2a72d86e5'].join(''),
        `["${'52'}${'77'}"]`,
    ];
    const violations = [];

    for (const file of collectPublicTextFiles(repositoryRoot)) {
        const content = readFileSync(file, 'utf8');
        for (const forbidden of forbiddenValues) {
            if (content.includes(forbidden)) {
                violations.push(`${relative(repositoryRoot, file)}: ${forbidden}`);
            }
        }
    }

    assert.deepEqual(violations, []);
});

test('verification email uses a deployment-neutral fallback and an optional safe logo URL', () => {
    const defaultMail = buildVerificationMail('123456');
    assert.doesNotMatch(defaultMail.html, /<img\b/i);
    assert.doesNotMatch(defaultMail.html, /https?:\/\//i);
    assert.match(defaultMail.html, /Cloudflare Temp Email/);

    const brandedMail = buildVerificationMail('123456', {
        brandName: 'Example Mail',
        logoUrl: 'https://assets.example.com/mail-logo.png',
    });
    assert.equal(brandedMail.fromName, 'Example Mail');
    assert.match(brandedMail.html, /<img\b[^>]*https:\/\/assets\.example\.com\/mail-logo\.png/);

    const unsafeMail = buildVerificationMail('123456', {
        brandName: '<script>alert(1)</script>',
        logoUrl: 'javascript:alert(1)',
    });
    assert.doesNotMatch(unsafeMail.html, /<script>|javascript:/i);
    assert.match(unsafeMail.html, /&lt;script&gt;/);

    const userSource = readRepositoryFile('worker/src/user_api/user.ts');
    const configRenderer = readRepositoryFile('.github/scripts/render-worker-toml.py');
    const configTemplate = readRepositoryFile('worker/wrangler.toml.template');
    for (const variable of [
        'VERIFICATION_MAIL_BRAND_NAME',
        'VERIFICATION_MAIL_LOGO_URL',
    ]) {
        assert.match(userSource, new RegExp(`c\\.env\\.${variable}`));
        assert.match(configRenderer, new RegExp(variable));
        assert.match(configTemplate, new RegExp(variable));
    }
});

test('public fork includes its maintenance and security contract', () => {
    const requiredFiles = [
        'SECURITY.md',
        'CONTRIBUTING.md',
        '.github/pull_request_template.md',
        'docs/fork-release-policy.md',
        '.github/workflows/upstream_sync.yml',
    ];
    for (const path of requiredFiles) {
        assert.equal(existsSync(join(repositoryRoot, path)), true, `${path} is required`);
    }

    const readme = readRepositoryFile('README.md');
    assert.match(readme, /Loven7 维护的 Fork/);
    assert.match(readme, /上游项目/);
    assert.match(readme, /管理套件/);
    assert.match(readme, /AI Agent/);
});

test('upstream sync opens a reviewable PR and tag builds create a GitHub Release', () => {
    const tagWorkflow = readRepositoryFile('.github/workflows/tag_build.yml');
    assert.match(tagWorkflow, /gh release create/);
    assert.match(tagWorkflow, /--generate-notes/);
    assert.match(tagWorkflow, /SHA256SUMS/);

    const syncWorkflow = readRepositoryFile('.github/workflows/upstream_sync.yml');
    assert.match(syncWorkflow, /pull-requests:\s*write/);
    assert.match(syncWorkflow, /gh pr create/);
    assert.doesNotMatch(syncWorkflow, /push[^\n]*origin[^\n]*main/);
});

test('release docs build verifies local release assets without production credentials', () => {
    const docsWorkflow = readRepositoryFile('.github/workflows/docs_deploy.yml');
    assert.doesNotMatch(docsWorkflow, /CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)/);
    assert.doesNotMatch(docsWorkflow, /pnpm run deploy/);
    assert.doesNotMatch(docsWorkflow, /dreamhunter2333\/cloudflare_temp_email\/releases\/latest/);
    assert.match(docsWorkflow, /gh release download/);
    assert.match(docsWorkflow, /sha256sum --check/);
    assert.match(docsWorkflow, /pnpm run build/);
    assert.match(docsWorkflow, /actions\/upload-artifact/);
});

test('gitignore excludes common local secrets and private deployment overlays', () => {
    const gitignore = readRepositoryFile('.gitignore');
    for (const pattern of [
        '.dev.vars*',
        '*.pem',
        '*.p12',
        '*.sqlite*',
        '.private/',
        'wrangler.*.toml',
    ]) {
        assert.match(gitignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});

test('public Wrangler template never stores authentication secrets as plain vars', () => {
    const template = readRepositoryFile('worker/wrangler.toml.template');
    const renderer = readRepositoryFile('.github/scripts/render-worker-toml.py');
    const deployWorkflow = readRepositoryFile('.github/workflows/backend_deploy.yaml');
    assert.doesNotMatch(template, /^\s*JWT_SECRET\s*=/m);
    assert.doesNotMatch(template, /^\s*ADMIN_PASSWORDS\s*=/m);
    assert.doesNotMatch(renderer, /add_var\(lines,\s*["'](?:JWT_SECRET|ADMIN_PASSWORDS|PASSWORDS)["']/);
    assert.match(template, /wrangler secret put JWT_SECRET/);
    assert.match(template, /wrangler secret put ADMIN_PASSWORDS/);
    assert.match(deployWorkflow, /"TEMP_MAIL_PASSWORDS_JSON": "PASSWORDS"/);
    assert.match(deployWorkflow, /--secrets-file/);
    assert.doesNotMatch(deployWorkflow, /wrangler secret bulk/);
});

test('fresh-clone dry-run uses a tracked deployment-neutral Wrangler config', () => {
    const packageJson = JSON.parse(readRepositoryFile('worker/package.json'));
    const ciConfig = readRepositoryFile('worker/wrangler.ci.toml');
    assert.match(packageJson.scripts.build, /--config wrangler\.ci\.toml/);
    assert.match(ciConfig, /main\s*=\s*"src\/worker\.ts"/);
    assert.match(ciConfig, /nodejs_compat/);
    assert.doesNotMatch(ciConfig, /(?:database_id|namespace_id|JWT_SECRET|ADMIN_PASSWORDS|PASSWORDS)\s*=/);
});

test('public deployment workflows require an explicit manual target', () => {
    for (const path of [
        '.github/workflows/backend_deploy.yaml',
        '.github/workflows/frontend_deploy.yaml',
        '.github/workflows/frontend_pagefunction_deploy.yaml',
    ]) {
        const workflow = readRepositoryFile(path);
        assert.match(workflow, /workflow_dispatch:/);
        assert.doesNotMatch(workflow, /^\s+tags:/m);
    }
    const backend = readRepositoryFile('.github/workflows/backend_deploy.yaml');
    const renderer = readRepositoryFile('.github/scripts/render-worker-toml.py');
    assert.match(backend, /TEMP_MAIL_WORKER_NAME/);
    assert.match(backend, /Missing required generated-config inputs/);
    assert.match(renderer, /TEMP_MAIL_WORKER_NAME 为空，必须显式指定 Worker 名称/);
});
