#!/bin/bash

# QAI Backend Environment Setup Script

echo "🚀 Setting up QAI Backend environment..."

# Check if .env already exists
if [ -f ".env" ]; then
    echo "⚠️  .env file already exists!"
    read -p "Do you want to overwrite it? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Setup cancelled."
        exit 1
    fi
fi

# Copy env.example to .env
cp env.example .env

echo "✅ Created .env file from env.example"

# Generate random secrets
JWT_SECRET=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
API_KEY_SECRET=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)

# Update .env with generated secrets
if command -v sed >/dev/null 2>&1; then
    sed -i.bak "s/your_jwt_secret_here_minimum_32_characters/$JWT_SECRET/g" .env
    sed -i.bak "s/your_api_key_secret_here_minimum_32_characters/$API_KEY_SECRET/g" .env
    rm .env.bak
    echo "✅ Generated random JWT_SECRET and API_KEY_SECRET"
else
    echo "⚠️  Please manually update JWT_SECRET and API_KEY_SECRET in .env file"
fi

echo ""
echo "📝 Next steps:"
echo "1. Edit .env file and add your Supabase credentials"
echo "2. Add your OpenAI API key"
echo "3. Run: npm install"
echo "4. Run: npm run dev"
echo ""
echo "🔧 Required environment variables:"
echo "   - SUPABASE_URL"
echo "   - SUPABASE_ANON_KEY" 
echo "   - SUPABASE_SERVICE_ROLE_KEY"
echo "   - OPENAI_API_KEY"
echo ""
echo "📖 See SETUP.md for detailed instructions"
