#!/usr/bin/env node

/**
 * AST Parser for TypeScript
 * Extracts methods, their metadata, and relationships from TypeScript source files
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

/**
 * Parse a TypeScript file and extract method information
 */
function parseTypeScriptFile(filePath) {
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceCode,
        ts.ScriptTarget.Latest,
        true
    );

    const methods = {};
    const classes = {};
    let currentClass = null;

    function visit(node) {
        // Class declarations
        if (ts.isClassDeclaration(node) && node.name) {
            const className = node.name.text;
            currentClass = className;
            classes[className] = {
                name: className,
                file: filePath,
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                methods: []
            };

            // Check for extends/implements
            if (node.heritageClauses) {
                node.heritageClauses.forEach(clause => {
                    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                        classes[className].extends = clause.types.map(t => t.expression.text).join(', ');
                    }
                    if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                        classes[className].implements = clause.types.map(t => t.expression.text).join(', ');
                    }
                });
            }
        }

        // Method declarations
        if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
            const methodName = node.name ? node.name.text : '<anonymous>';
            const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

            const method = {
                name: methodName,
                file: filePath,
                line: startPos.line + 1,
                endLine: endPos.line + 1,
                type: getMethodType(node),
                parameters: extractParameters(node),
                returns: extractReturnType(node),
                description: extractJSDoc(node),
                dependencies: {
                    methods: [],
                    services: [],
                    classes: [],
                    imports: []
                },
                executionPaths: {
                    branches: [],
                    loops: [],
                    asyncOperations: []
                },
                errorHandling: {
                    tryCatch: false,
                    catchBlocks: [],
                    throws: []
                },
                sideEffects: {
                    stateChanges: [],
                    events: [],
                    logging: [],
                    externalCalls: []
                }
            };

            // Analyze method body
            if (node.body) {
                analyzeMethodBody(node.body, method, sourceFile);
            }

            methods[methodName] = method;

            if (currentClass) {
                classes[currentClass].methods.push(methodName);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    return { methods, classes };
}

/**
 * Get method type (private/public/static/async)
 */
function getMethodType(node) {
    const modifiers = node.modifiers || [];
    const types = [];

    if (modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) types.push('private');
    if (modifiers.some(m => m.kind === ts.SyntaxKind.PublicKeyword)) types.push('public');
    if (modifiers.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword)) types.push('protected');
    if (modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) types.push('static');
    if (modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) types.push('async');

    return types.join(' ') || 'public';
}

/**
 * Extract method parameters
 */
function extractParameters(node) {
    if (!node.parameters) return [];

    return node.parameters.map(param => ({
        name: param.name.text,
        type: param.type ? param.type.getText() : 'any',
        required: !param.questionToken,
        default: param.initializer ? param.initializer.getText() : null
    }));
}

/**
 * Extract return type
 */
function extractReturnType(node) {
    if (!node.type) {
        // Check if async (returns Promise)
        const modifiers = node.modifiers || [];
        if (modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            return { type: 'Promise<any>', description: 'Async method' };
        }
        return { type: 'void', description: 'No return type specified' };
    }

    return {
        type: node.type.getText(),
        description: 'Return type from signature'
    };
}

/**
 * Extract JSDoc comments
 */
function extractJSDoc(node) {
    const sourceFile = node.getSourceFile();
    const fullText = sourceFile.getFullText();
    const nodeStart = node.getFullStart();

    // Look for JSDoc comments before the node
    const beforeNode = fullText.substring(Math.max(0, nodeStart - 500), nodeStart);
    const jsdocMatch = beforeNode.match(/\/\*\*[\s\S]*?\*\//);

    if (jsdocMatch) {
        return jsdocMatch[0]
            .replace(/\/\*\*|\*\//g, '')
            .replace(/\*\s*/g, '')
            .trim();
    }

    return '';
}

/**
 * Analyze method body for execution paths, error handling, etc.
 */
function analyzeMethodBody(body, method, sourceFile) {
    function analyzeNode(node) {
        // Try/Catch blocks
        if (ts.isTryStatement(node)) {
            method.errorHandling.tryCatch = true;
            if (node.catchClause) {
                method.errorHandling.catchBlocks.push({
                    line: sourceFile.getLineAndCharacterOfPosition(node.catchClause.getStart()).line + 1,
                    errorType: node.catchClause.variableDeclaration?.type?.getText() || 'Error'
                });
            }
        }

        // Throw statements
        if (ts.isThrowStatement(node)) {
            method.errorHandling.throws.push({
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            });
        }

        // If statements
        if (ts.isIfStatement(node)) {
            method.executionPaths.branches.push({
                condition: node.expression.getText(),
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            });
        }

        // Loops
        if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node)) {
            method.executionPaths.loops.push({
                type: node.kind === ts.SyntaxKind.ForStatement ? 'for' :
                      node.kind === ts.SyntaxKind.WhileStatement ? 'while' : 'for...of',
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            });
        }

        // Await expressions
        if (ts.isAwaitExpression(node)) {
            method.executionPaths.asyncOperations.push({
                type: 'await',
                operation: node.expression.getText(),
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            });
        }

        // Method calls
        if (ts.isCallExpression(node)) {
            const callText = node.expression.getText();

            // Check for logger calls
            if (callText.includes('logger.')) {
                method.sideEffects.logging.push({
                    level: callText.split('.')[1]?.split('(')[0] || 'info',
                    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
                });
            }

            // Check for emit calls
            if (callText.includes('emit') || callText.includes('Emit')) {
                method.sideEffects.events.push({
                    type: 'emit',
                    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
                });
            }

            // Extract method dependencies
            if (ts.isPropertyAccessExpression(node.expression)) {
                const methodName = node.expression.name.text;
                if (!method.dependencies.methods.includes(methodName)) {
                    method.dependencies.methods.push(methodName);
                }
            }
        }

        ts.forEachChild(node, analyzeNode);
    }

    if (ts.isBlock(node)) {
        node.statements.forEach(analyzeNode);
    } else {
        analyzeNode(body);
    }
}

/**
 * Main function to process files
 */
function processFiles(files, outputDir) {
    const allMethods = {};
    const allClasses = {};

    files.forEach(file => {
        if (!fs.existsSync(file)) {
            console.warn(`File not found: ${file}`);
            return;
        }

        try {
            const { methods, classes } = parseTypeScriptFile(file);
            Object.assign(allMethods, methods);
            Object.assign(allClasses, classes);
        } catch (error) {
            console.error(`Error parsing ${file}:`, error.message);
        }
    });

    // Write methods.json
    const methodsPath = path.join(outputDir, 'methods.json');
    fs.writeFileSync(methodsPath, JSON.stringify(allMethods, null, 2));

    console.log(`✅ Generated ${methodsPath} with ${Object.keys(allMethods).length} methods`);
    console.log(`✅ Found ${Object.keys(allClasses).length} classes`);

    return { methods: allMethods, classes: allClasses };
}

// CLI usage
if (require.main === module) {
    const args = process.argv.slice(2);
    const files = args.filter(arg => arg.endsWith('.ts'));
    const outputDir = args.find(arg => arg.startsWith('--output='))?.split('=')[1] || process.cwd();

    if (files.length === 0) {
        console.error('Usage: node generate-diagrams.js <file1.ts> [file2.ts ...] [--output=dir]');
        process.exit(1);
    }

    processFiles(files, outputDir);
}

module.exports = { parseTypeScriptFile, processFiles };
