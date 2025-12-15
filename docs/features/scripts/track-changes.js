#!/usr/bin/env node

/**
 * Change Tracker
 * Tracks changes to methods using Git and AST parsing
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseTypeScriptFile } = require('./generate-diagrams');

/**
 * Get git information for a file
 */
function getGitInfo(filePath) {
    try {
        const gitDir = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
        const relativePath = path.relative(gitDir, filePath);

        // Get last commit hash
        const commitHash = execSync(`git log -1 --format=%H -- "${relativePath}"`, { encoding: 'utf-8' }).trim();

        // Get last commit date
        const commitDate = execSync(`git log -1 --format=%ai -- "${relativePath}"`, { encoding: 'utf-8' }).trim();

        // Get author
        const author = execSync(`git log -1 --format=%an -- "${relativePath}"`, { encoding: 'utf-8' }).trim();

        // Get diff for this commit
        const diff = execSync(`git show ${commitHash} -- "${relativePath}"`, { encoding: 'utf-8' });

        return {
            commit: commitHash.substring(0, 7),
            date: commitDate.split(' ')[0],
            author,
            diff
        };
    } catch (error) {
        return {
            commit: 'unknown',
            date: new Date().toISOString().split('T')[0],
            author: 'unknown',
            diff: ''
        };
    }
}

/**
 * Detect changes in methods by comparing with previous version
 */
function detectMethodChanges(currentMethods, previousMethodsPath) {
    const changes = [];

    if (!fs.existsSync(previousMethodsPath)) {
        // All methods are new
        Object.keys(currentMethods).forEach(methodName => {
            changes.push({
                method: methodName,
                action: 'new',
                details: 'Method detected for the first time'
            });
        });
        return changes;
    }

    const previousMethods = JSON.parse(fs.readFileSync(previousMethodsPath, 'utf-8'));

    // Check for new methods
    Object.keys(currentMethods).forEach(methodName => {
        if (!previousMethods[methodName]) {
            changes.push({
                method: methodName,
                action: 'new',
                details: 'New method added'
            });
        }
    });

    // Check for modified methods
    Object.keys(currentMethods).forEach(methodName => {
        if (previousMethods[methodName]) {
            const current = currentMethods[methodName];
            const previous = previousMethods[methodName];

            // Compare key properties
            if (current.line !== previous.line ||
                current.endLine !== previous.endLine ||
                JSON.stringify(current.parameters) !== JSON.stringify(previous.parameters) ||
                JSON.stringify(current.returns) !== JSON.stringify(previous.returns)) {
                changes.push({
                    method: methodName,
                    action: 'modified',
                    details: 'Method signature or implementation changed'
                });
            }
        }
    });

    // Check for deleted methods
    Object.keys(previousMethods).forEach(methodName => {
        if (!currentMethods[methodName]) {
            changes.push({
                method: methodName,
                action: 'deleted',
                details: 'Method removed'
            });
        }
    });

    return changes;
}

/**
 * Update changelog with new changes
 */
function updateChangelog(changelogPath, changes, gitInfo) {
    let changelog = { entries: [] };

    if (fs.existsSync(changelogPath)) {
        changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf-8'));
    }

    // Add new entry if there are changes
    if (changes.length > 0) {
        changelog.entries.unshift({
            date: gitInfo.date,
            commit: gitInfo.commit,
            author: gitInfo.author,
            changes: changes.map(change => ({
                method: change.method,
                action: change.action,
                details: change.details
            }))
        });

        // Keep only last 50 entries
        changelog.entries = changelog.entries.slice(0, 50);
    }

    fs.writeFileSync(changelogPath, JSON.stringify(changelog, null, 2));
    return changelog;
}

/**
 * Update methods.json with git metadata
 */
function updateMethodsWithGitInfo(methods, gitInfo) {
    Object.keys(methods).forEach(methodName => {
        methods[methodName].lastModified = gitInfo.date;
        methods[methodName].modifiedBy = gitInfo.commit;
        methods[methodName].author = gitInfo.author;

        // Set created date if not exists
        if (!methods[methodName].created) {
            methods[methodName].created = gitInfo.date;
        }
    });

    return methods;
}

/**
 * Main function to track changes
 */
function trackChanges(files, featureDir) {
    const methodsPath = path.join(featureDir, 'methods.json');
    const changelogPath = path.join(featureDir, 'changelog.json');
    const previousMethodsPath = path.join(featureDir, 'methods.json.previous');

    // Parse current methods
    const allMethods = {};
    files.forEach(file => {
        if (!fs.existsSync(file)) {
            console.warn(`File not found: ${file}`);
            return;
        }

        try {
            const { methods } = parseTypeScriptFile(file);
            Object.assign(allMethods, methods);
        } catch (error) {
            console.error(`Error parsing ${file}:`, error.message);
        }
    });

    // Get git info from first file
    const gitInfo = files.length > 0 ? getGitInfo(files[0]) : {
        commit: 'unknown',
        date: new Date().toISOString().split('T')[0],
        author: 'unknown'
    };

    // Update methods with git info
    const methodsWithGit = updateMethodsWithGitInfo(allMethods, gitInfo);

    // Detect changes
    const changes = detectMethodChanges(methodsWithGit, previousMethodsPath);

    // Save previous version for next comparison
    if (fs.existsSync(methodsPath)) {
        fs.copyFileSync(methodsPath, previousMethodsPath);
    }

    // Write updated methods
    fs.writeFileSync(methodsPath, JSON.stringify(methodsWithGit, null, 2));

    // Update changelog
    updateChangelog(changelogPath, changes, gitInfo);

    console.log(`✅ Tracked changes for ${Object.keys(methodsWithGit).length} methods`);
    console.log(`✅ Detected ${changes.length} changes`);

    return { methods: methodsWithGit, changes };
}

// CLI usage
if (require.main === module) {
    const args = process.argv.slice(2);
    const files = args.filter(arg => arg.endsWith('.ts'));
    const featureDir = args.find(arg => arg.startsWith('--feature='))?.split('=')[1];

    if (files.length === 0 || !featureDir) {
        console.error('Usage: node track-changes.js <file1.ts> [file2.ts ...] --feature=feature-dir');
        process.exit(1);
    }

    trackChanges(files, featureDir);
}

module.exports = { trackChanges, getGitInfo, detectMethodChanges };
