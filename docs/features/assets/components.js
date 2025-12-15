// Components for feature pages

function renderMermaidDiagram(diagramCode, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    mermaid.initialize({ startOnLoad: true, theme: 'default' });

    const div = document.createElement('div');
    div.className = 'mermaid';
    div.textContent = diagramCode;
    container.appendChild(div);

    mermaid.init(undefined, div);
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
    // This will be populated with actual method data
    alert(`Method details for: ${methodName}\n\nFull details will be shown here.`);
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
