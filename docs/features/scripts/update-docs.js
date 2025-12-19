#!/usr/bin/env node

/**
 * Documentation Updater
 * Generates Mermaid diagrams from methods data and updates documentation
 */

const fs = require('fs');
const path = require('path');

/**
 * Generate Mermaid flowchart from methods
 */
function generateMermaidDiagram(methods, classes) {
    let diagram = 'flowchart TD\n';
    const nodeIds = new Map();
    let nodeCounter = 0;

    // Create node IDs
    Object.keys(methods).forEach(methodName => {
        const id = `M${nodeCounter++}`;
        nodeIds.set(methodName, id);
    });

    // Add nodes
    Object.entries(methods).forEach(([methodName, method]) => {
        const nodeId = nodeIds.get(methodName);
        const status = method.status || 'unchanged';
        const statusEmoji = status === 'new' ? '🟢 NEW' :
                           status === 'enhanced' ? '🔴 Enhanced' :
                           status === 'refactored' ? '🟡 Refactored' : '🔵';

        diagram += `    ${nodeId}["${methodName}<br/>${statusEmoji}"]\n`;
    });

    // Add edges based on dependencies
    Object.entries(methods).forEach(([methodName, method]) => {
        const fromId = nodeIds.get(methodName);

        // Add edges for method calls
        if (method.dependencies && method.dependencies.methods) {
            method.dependencies.methods.forEach(calledMethod => {
                const toId = nodeIds.get(calledMethod);
                if (toId) {
                    diagram += `    ${fromId} --> ${toId}\n`;
                }
            });
        }
    });

    // Add styling
    Object.entries(methods).forEach(([methodName, method]) => {
        const nodeId = nodeIds.get(methodName);
        const status = method.status || 'unchanged';

        if (status === 'new') {
            diagram += `    style ${nodeId} fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px\n`;
        } else if (status === 'enhanced') {
            diagram += `    style ${nodeId} fill:#ffebee,stroke:#c62828,stroke-width:2px\n`;
        } else if (status === 'refactored') {
            diagram += `    style ${nodeId} fill:#fff4e1,stroke:#e65100,stroke-width:2px\n`;
        } else {
            diagram += `    style ${nodeId} fill:#e1f5ff,stroke:#01579b,stroke-width:2px\n`;
        }
    });

    return diagram;
}

/**
 * Generate detailed flow diagram with execution paths
 */
function generateDetailedFlowDiagram(methods, entryMethod) {
    if (!methods[entryMethod]) {
        return '// Entry method not found';
    }

    let diagram = 'flowchart TD\n';
    const visited = new Set();
    const nodeIds = new Map();
    let nodeCounter = 0;

    function addNode(methodName) {
        if (!nodeIds.has(methodName)) {
            const id = `N${nodeCounter++}`;
            nodeIds.set(methodName, id);
        }
        return nodeIds.get(methodName);
    }

    function traverseMethod(methodName, parentId = null) {
        if (visited.has(methodName) || !methods[methodName]) return;
        visited.add(methodName);

        const method = methods[methodName];
        const nodeId = addNode(methodName);
        const status = method.status || 'unchanged';
        const statusEmoji = status === 'new' ? '🟢' :
                           status === 'enhanced' ? '🔴' :
                           status === 'refactored' ? '🟡' : '🔵';

        diagram += `    ${nodeId}["${methodName}<br/>${statusEmoji}"]\n`;

        if (parentId) {
            diagram += `    ${parentId} --> ${nodeId}\n`;
        }

        // Add execution paths
        if (method.executionPaths && method.executionPaths.branches) {
            method.executionPaths.branches.forEach((branch, idx) => {
                const branchId = `B${nodeCounter++}`;
                diagram += `    ${nodeId} -->|"${branch.condition}"| ${branchId}["Branch ${idx + 1}"]\n`;
            });
        }

        // Traverse dependencies
        if (method.dependencies && method.dependencies.methods) {
            method.dependencies.methods.forEach(depMethod => {
                traverseMethod(depMethod, nodeId);
            });
        }
    }

    traverseMethod(entryMethod);

    // Add styling
    Object.entries(methods).forEach(([methodName, method]) => {
        const nodeId = nodeIds.get(methodName);
        if (nodeId) {
            const status = method.status || 'unchanged';
            if (status === 'new') {
                diagram += `    style ${nodeId} fill:#e8f5e9,stroke:#2e7d32\n`;
            } else if (status === 'enhanced') {
                diagram += `    style ${nodeId} fill:#ffebee,stroke:#c62828\n`;
            } else if (status === 'refactored') {
                diagram += `    style ${nodeId} fill:#fff4e1,stroke:#e65100\n`;
            }
        }
    });

    return diagram;
}

/**
 * Update documentation files
 */
function updateDocs(featureDir, entryMethod = null) {
    const methodsPath = path.join(featureDir, 'methods.json');
    const diagramPath = path.join(featureDir, 'flow-diagram.md');

    if (!fs.existsSync(methodsPath)) {
        console.error(`Methods file not found: ${methodsPath}`);
        return;
    }

    const methods = JSON.parse(fs.readFileSync(methodsPath, 'utf-8'));

    // Generate diagram
    let diagram;
    if (entryMethod && methods[entryMethod]) {
        diagram = generateDetailedFlowDiagram(methods, entryMethod);
    } else {
        diagram = generateMermaidDiagram(methods, {});
    }

    // Write diagram
    fs.writeFileSync(diagramPath, diagram);
    console.log(`✅ Updated ${diagramPath}`);

    return diagram;
}

// CLI usage
if (require.main === module) {
    const args = process.argv.slice(2);
    const featureDir = args.find(arg => arg.startsWith('--feature='))?.split('=')[1];
    const entryMethod = args.find(arg => arg.startsWith('--entry='))?.split('=')[1];

    if (!featureDir) {
        console.error('Usage: node update-docs.js --feature=feature-dir [--entry=methodName]');
        process.exit(1);
    }

    updateDocs(featureDir, entryMethod);
}

module.exports = { generateMermaidDiagram, generateDetailedFlowDiagram, updateDocs };
