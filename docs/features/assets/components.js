// Components for feature pages

// Global methods data storage
let methodsData = {};
let methodsDataLoaded = false;

// Load methods data for tooltips
async function loadMethodsData() {
    if (methodsDataLoaded) return methodsData;

    try {
        // Try to get methods.json from current page directory
        const currentPath = window.location.pathname;
        const featurePath = currentPath.substring(0, currentPath.lastIndexOf('/'));
        const methodsPath = featurePath + '/methods.json';

        const response = await fetch(methodsPath);
        if (response.ok) {
            methodsData = await response.json();
            methodsDataLoaded = true;
        }
    } catch (e) {
        console.warn('Could not load methods.json for tooltips:', e);
    }

    return methodsData;
}

function renderMermaidDiagram(diagramCode, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    mermaid.initialize({
        startOnLoad: true,
        theme: 'default',
        securityLevel: 'loose',
        flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            curve: 'basis'
        }
    });

    const div = document.createElement('div');
    div.className = 'mermaid';
    div.textContent = diagramCode;
    container.appendChild(div);

    mermaid.init(undefined, div).then(() => {
        // After diagram is rendered, make nodes interactive
        setTimeout(() => {
            makeDiagramInteractive(containerId);
        }, 500);
    });
}

// Make Mermaid diagram nodes clickable and show tooltips
async function makeDiagramInteractive(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Load methods data (check window.methodsData first if set by page)
    if (typeof window !== 'undefined' && window.methodsData && Object.keys(window.methodsData).length > 0) {
        methodsData = window.methodsData;
        methodsDataLoaded = true;
    } else {
        await loadMethodsData();
    }

    // Find all SVG nodes in the diagram
    const svg = container.querySelector('svg');
    if (!svg) return;

    // Find all node elements (rectangles, circles, etc.)
    const nodes = svg.querySelectorAll('g.node, g[id^="flowchart-"], rect, circle, polygon');

    nodes.forEach(node => {
        // Get the text content to find method name
        const textElement = node.closest('g')?.querySelector('text');
        if (!textElement) return;

        const nodeText = textElement.textContent || '';

        // Extract method name from node text (remove emojis and status)
        const methodName = extractMethodName(nodeText);

        if (methodName) {
            // Find method data
            const methodData = findMethodData(methodName);

            if (methodData) {
                // Make node clickable
                const nodeGroup = node.closest('g') || node.parentElement;
                if (nodeGroup) {
                    nodeGroup.style.cursor = 'pointer';
                    nodeGroup.classList.add('diagram-node-clickable');

                    // Add click handler
                    nodeGroup.addEventListener('click', (e) => {
                        e.stopPropagation();
                        showMethodTooltip(methodData, e);
                    });

                    // Add hover effect
                    nodeGroup.addEventListener('mouseenter', () => {
                        nodeGroup.style.opacity = '0.8';
                    });
                    nodeGroup.addEventListener('mouseleave', () => {
                        nodeGroup.style.opacity = '1';
                    });
                }
            }
        }
    });
}

// Extract method name from node text
function extractMethodName(nodeText) {
    // Remove emojis and status indicators
    let cleaned = nodeText
        .replace(/🟢|🔴|🟡|🔵|NEW|Enhanced|Refactored|Core Orchestrator|Page Analyzer|Action Generator|Command Executor|Result Validator|Pre-Action Analyzer|Post-Action Analyzer|Self-Healing|Contextual Decide|Main Loop|Wait SPA|Screenshot|Wait Modals|DOM Analysis|Enhance DOM|Match Elements|Enhance Modals|Logic Analysis|Context Builder|Generate Actions|Validate Cache|Build History|Build Elements|Build DOM|Get HTML|Enhanced PII Masking|Enhanced JSON Parsing|Sanitize|Return|Main Action Orchestrator|Pre-Action Handler|Logging Helper|Selector Validator|Command Executor|Wait Effect|Async Handler|Ensure Complete|Verify Success|Screenshot Helper|Post-Action Handler|Check State|Detect Changes|Failure Handler|Error Context|Retry Check|Next|Decide Next|Build Result|Wait|Retry|Skip|Validate Test|Build Summary|Upload Graph|Test Complete|Test Execution Starts|Initialize Services|Main Loop Iteration|Page Analysis|Fallback|Enhanced Prompt/g, '')
        .replace(/<br\s*\/?>/gi, ' ')
        .trim();

    // Try to extract method name in different formats:
    // 1. "ClassName.methodName" -> "methodName"
    // 2. "methodName" -> "methodName"
    // 3. "methodName<br/>description" -> "methodName"

    // Remove class prefix if present (e.g., "IntelligentTestOrchestrator.execute" -> "execute")
    const classMethodMatch = cleaned.match(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (classMethodMatch) {
        return classMethodMatch[1];
    }

    // Extract method name (usually before first space or special char)
    const match = cleaned.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (match) {
        return match[1];
    }

    // Fallback: return first word
    return cleaned.split(/\s/)[0];
}

// Find method data by name
function findMethodData(methodName) {
    if (!methodsData || Object.keys(methodsData).length === 0) return null;

    // Try exact match first
    if (methodsData[methodName]) {
        return methodsData[methodName];
    }

    // Try case-insensitive match
    const lowerName = methodName.toLowerCase();
    for (const key in methodsData) {
        if (key.toLowerCase() === lowerName) {
            return methodsData[key];
        }
    }

    // Try partial match (method name contains or is contained)
    for (const key in methodsData) {
        if (key.toLowerCase().includes(lowerName) || lowerName.includes(key.toLowerCase())) {
            return methodsData[key];
        }
    }

    return null;
}

// Show tooltip/modal with method details
function showMethodTooltip(methodData, event) {
    // Remove existing tooltip
    const existingTooltip = document.getElementById('method-tooltip-modal');
    if (existingTooltip) {
        existingTooltip.remove();
    }

    // Create modal
    const modal = document.createElement('div');
    modal.id = 'method-tooltip-modal';
    modal.className = 'method-tooltip-modal';

    // Build method details HTML
    const details = buildMethodDetailsHTML(methodData);

    modal.innerHTML = `
        <div class="method-tooltip-content">
            <div class="method-tooltip-header">
                <h3>${methodData.name || 'Method Details'}</h3>
                <button class="method-tooltip-close" onclick="closeMethodTooltip()">&times;</button>
            </div>
            <div class="method-tooltip-body">
                ${details}
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close on background click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeMethodTooltip();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', function escapeHandler(e) {
        if (e.key === 'Escape') {
            closeMethodTooltip();
            document.removeEventListener('keydown', escapeHandler);
        }
    });
}

// Build HTML for method details
function buildMethodDetailsHTML(method) {
    let html = '';

    // Status badge
    if (method.status) {
        html += `<div class="method-tooltip-status badge-${method.status}">${method.status}</div>`;
    }

    // Description
    if (method.description) {
        html += `<div class="method-tooltip-section">
            <h4>📝 Description</h4>
            <p>${method.description}</p>
        </div>`;
    }

    // File and line
    if (method.file) {
        const relativePath = method.file.startsWith('src/') ? method.file : `src/${method.file}`;
        html += `<div class="method-tooltip-section">
            <h4>📍 Location</h4>
            <p><a href="../../../../${relativePath}#L${method.line || ''}" target="_blank">${method.file}:${method.line || 'N/A'}</a></p>
        </div>`;
    }

    // Parameters
    if (method.parameters && method.parameters.length > 0) {
        html += `<div class="method-tooltip-section">
            <h4>📥 Parameters</h4>
            <ul>${method.parameters.map(p => `<li><code>${p.name}</code>: ${p.type || 'any'}${p.description ? ` - ${p.description}` : ''}</li>`).join('')}</ul>
        </div>`;
    }

    // Returns
    if (method.returns) {
        html += `<div class="method-tooltip-section">
            <h4>📤 Returns</h4>
            <p><code>${method.returns.type || method.returns}</code>${method.returns.description ? ` - ${method.returns.description}` : ''}</p>
        </div>`;
    }

    // Dependencies
    if (method.dependencies && method.dependencies.methods && method.dependencies.methods.length > 0) {
        html += `<div class="method-tooltip-section">
            <h4>🔗 Calls</h4>
            <ul>${method.dependencies.methods.map(m => `<li><code>${m}</code></li>`).join('')}</ul>
        </div>`;
    }

    // Error handling
    if (method.errorHandling) {
        html += `<div class="method-tooltip-section">
            <h4>⚠️ Error Handling</h4>
            <p>${method.errorHandling}</p>
        </div>`;
    }

    // Side effects
    if (method.sideEffects) {
        html += `<div class="method-tooltip-section">
            <h4>⚡ Side Effects</h4>
            <p>${method.sideEffects}</p>
        </div>`;
    }

    // Execution paths
    if (method.executionPaths && method.executionPaths.length > 0) {
        html += `<div class="method-tooltip-section">
            <h4>🛤️ Execution Paths</h4>
            <ul>${method.executionPaths.map(p => `<li>${p}</li>`).join('')}</ul>
        </div>`;
    }

    if (!html) {
        html = '<p>No additional information available.</p>';
    }

    return html;
}

// Close tooltip
function closeMethodTooltip() {
    const modal = document.getElementById('method-tooltip-modal');
    if (modal) {
        modal.remove();
    }
}

function renderMethodsList(methods, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = methods.map(method => `
        <div class="method-card ${method.status || 'unchanged'}" onclick="showMethodDetails('${method.name}')">
            <div class="method-header">
                <span class="method-name">${method.name}</span>
                <span class="method-badge badge-${method.status || 'unchanged'}">${method.status || 'unchanged'}</span>
            </div>
            <div style="color: #999; font-size: 0.85em; margin-bottom: 8px;">${method.service || 'Unknown'}</div>
            <div class="method-description">${method.description || 'No description'}</div>
            ${method.file ? `<div style="color: #999; font-size: 0.8em; margin-top: 8px;">📍 ${method.file}:${method.line || ''}</div>` : ''}
        </div>
    `).join('');
}

function renderChangelog(entries, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = entries.map(entry => `
        <div class="changelog-entry">
            <div class="changelog-date">${entry.date}</div>
            <div class="changelog-commit">Commit: ${entry.commit}</div>
            <div class="changelog-changes">
                ${entry.changes.map(change => `
                    <div class="change-item">
                        <strong>${change.method}</strong>: ${change.action}
                        ${change.details ? `<div class="change-details">${change.details}</div>` : ''}
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
}

function showMethodDetails(methodName) {
    // Find method data
    loadMethodsData().then(() => {
        const methodData = methodsData[methodName] || findMethodData(methodName);

        if (methodData) {
            // Create a fake event to show tooltip
            const fakeEvent = {
                stopPropagation: () => {},
                preventDefault: () => {}
            };
            showMethodTooltip(methodData, fakeEvent);
        } else {
            alert(`Method details for: ${methodName}\n\nNo additional information available.`);
        }
    });
}

function filterMethods(type, event) {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    if (event && event.target) {
        event.target.classList.add('active');
    }

    const cards = document.querySelectorAll('.method-card');
    cards.forEach(card => {
        if (type === 'all' || card.classList.contains(type)) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

function searchMethods() {
    const query = document.getElementById('methodSearchBox').value.toLowerCase();
    const cards = document.querySelectorAll('.method-card');
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? 'block' : 'none';
    });
}
