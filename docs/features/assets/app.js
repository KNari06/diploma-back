const features = [
    {
        id: 'intelligent-testing',
        title: 'Intelligent Testing Flow',
        description: 'Complete flow of intelligent UI testing with AI-driven action generation and execution',
        category: 'core',
        path: 'features/intelligent-testing/index.html',
        methods: 60,
        lastModified: '2024-12-15',
        status: 'active'
    },
    {
        id: 'chat-flow',
        title: 'Chat Flow (POST /api/v1/chat)',
        description: 'Complete flow of message processing from user input to AI response with all handlers',
        category: 'api',
        path: 'features/chat-flow/index.html',
        methods: 45,
        lastModified: '2024-12-15',
        status: 'active',
        priority: 'high'
    },
    {
        id: 'authentication',
        title: 'Authentication & Authorization',
        description: 'OAuth flow, JWT tokens, session management, and role-based access control',
        category: 'api',
        path: 'features/authentication/index.html',
        methods: 20,
        lastModified: '2024-12-10',
        status: 'active'
    },
    {
        id: 'prompts-system',
        title: 'Prompts System',
        description: 'AI prompts with versioning, changes tracking, and usage analytics',
        category: 'ai',
        path: 'features/prompts-system/index.html',
        methods: 15,
        lastModified: '2024-12-14',
        status: 'active'
    },
    {
        id: 'packages',
        title: 'Packages System',
        description: 'Package structure, dependencies, imports/exports, and module organization',
        category: 'core',
        path: 'features/packages/index.html',
        methods: 10,
        lastModified: '2024-12-05',
        status: 'active'
    },
    {
        id: 'websocket',
        title: 'WebSocket Flow',
        description: 'Real-time connections, events, and updates for test progress and graph visualization',
        category: 'api',
        path: 'features/websocket/index.html',
        methods: 12,
        lastModified: '2024-12-12',
        status: 'active'
    },
    {
        id: 'credits-system',
        title: 'Credits System',
        description: 'Credit allocation, deduction, limits, and subscription plan management',
        category: 'core',
        path: 'features/credits-system/index.html',
        methods: 18,
        lastModified: '2024-12-13',
        status: 'active'
    },
    {
        id: 'api-routing',
        title: 'API Routing',
        description: 'Request routing, middleware chain, handlers, and validation flow',
        category: 'api',
        path: 'features/api-routing/index.html',
        methods: 25,
        lastModified: '2024-12-15',
        status: 'active'
    },
    {
        id: 'error-handling',
        title: 'Error Handling',
        description: 'Error codes, patterns, troubleshooting guide, and error response structure',
        category: 'api',
        path: 'features/error-handling/index.html',
        methods: 15,
        lastModified: '2024-12-15',
        status: 'active'
    },
    {
        id: 'rate-limiting',
        title: 'Rate Limiting',
        description: 'Rate limiting configuration, limits per endpoint, throttling mechanisms, and rate limit errors',
        category: 'api',
        path: 'features/rate-limiting/index.html',
        methods: 10,
        lastModified: '2024-12-15',
        status: 'active'
    }
];

let currentFilter = 'all';

function renderFeatures(filter = 'all') {
    const grid = document.getElementById('featuresGrid');
    const filtered = filter === 'all'
        ? features
        : features.filter(f => f.category === filter);

    grid.innerHTML = filtered.map(feature => `
        <a href="${feature.path}" class="feature-card ${feature.category}">
            <div class="feature-header">
                <div class="feature-title">${feature.title}</div>
                <span class="feature-badge badge-${feature.category}">${feature.category}</span>
            </div>
            <div class="feature-description">${feature.description}</div>
            <div class="feature-meta">
                <span>📊 ${feature.methods} methods</span>
                <span>📅 ${feature.lastModified}</span>
                ${feature.priority ? `<span>⭐ ${feature.priority} priority</span>` : ''}
            </div>
        </a>
    `).join('');

    updateStats();
}

function filterFeatures(category, event) {
    currentFilter = category;
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    if (event && event.target) {
        event.target.classList.add('active');
    }
    renderFeatures(category);
}

function searchFeatures() {
    const query = document.getElementById('searchBox').value.toLowerCase();
    const cards = document.querySelectorAll('.feature-card');
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? 'block' : 'none';
    });
}

function updateStats() {
    const totalMethods = features.reduce((sum, f) => sum + f.methods, 0);
    const lastUpdated = features.reduce((latest, f) => {
        return f.lastModified > latest ? f.lastModified : latest;
    }, '');
    const changedThisWeek = features.filter(f => {
        const date = new Date(f.lastModified);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return date > weekAgo;
    }).length;

    document.getElementById('totalMethods').textContent = totalMethods;
    document.getElementById('lastUpdated').textContent = lastUpdated || '-';
    document.getElementById('changedThisWeek').textContent = changedThisWeek;
}

document.getElementById('searchBox').addEventListener('keyup', searchFeatures);

// Initialize
renderFeatures();
