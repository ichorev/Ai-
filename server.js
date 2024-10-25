const express = require('express');
const path = require('path');
const app = express();

// Import OpenAI
const OpenAI = require('openai');

// Check for API key
if (!process.env.Apikey) {
    console.error('ERROR: Apikey environment variable is missing');
    process.exit(1);
}

// Initialize OpenAI with API key from environment variable
const openai = new OpenAI({
    apiKey: process.env.Apikey.trim()
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Advanced access code system with features
const accessCodes = new Map([
    ['UNLIMITED123', { 
        uses: Infinity,
        type: 'UNLIMITED',
        description: 'Unlimited uses, no cooldown'
    }],
    ['PREMIUM50', { 
        uses: 50,
        type: 'PREMIUM',
        cooldown: 3600000, // 1 hour in milliseconds
        description: '50 uses, resets every hour'
    }],
    ['TURBO25', { 
        uses: 25,
        type: 'TURBO',
        cooldown: 1800000, // 30 minutes
        description: '25 uses, resets every 30 minutes'
    }],
    ['TRIAL10', { 
        uses: 10,
        type: 'TRIAL',
        cooldown: 3600000, // 1 hour
        description: '10 uses, resets every hour'
    }],
    ['VIP100', { 
        uses: 100,
        type: 'VIP',
        cooldown: 7200000, // 2 hours
        description: '100 uses, resets every 2 hours'
    }]
]);

// Store usage history
const usageHistory = new Map();

// Function to check and reset cooldown
function checkAndResetCooldown(accessCode, codeData) {
    const now = Date.now();
    const history = usageHistory.get(accessCode);

    if (!history) return true;

    // If code has cooldown and enough time has passed, reset uses
    if (codeData.cooldown && (now - history.lastReset) >= codeData.cooldown) {
        usageHistory.set(accessCode, {
            uses: codeData.uses,
            lastReset: now,
            lastUsed: history.lastUsed
        });
        return true;
    }

    return false;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/verify-access', (req, res) => {
    const { accessCode } = req.body;
    const now = Date.now();
    
    if (accessCodes.has(accessCode)) {
        const codeData = accessCodes.get(accessCode);
        const history = usageHistory.get(accessCode);

        // Check if this is first use
        if (!history) {
            usageHistory.set(accessCode, {
                uses: codeData.uses - 1,
                lastReset: now,
                lastUsed: now
            });
            res.json({ 
                success: true,
                type: codeData.type,
                usesLeft: codeData.uses - 1,
                description: codeData.description
            });
            return;
        }

        // Check cooldown reset
        checkAndResetCooldown(accessCode, codeData);
        const updatedHistory = usageHistory.get(accessCode);

        // Check if has uses left
        if (updatedHistory.uses > 0 || codeData.uses === Infinity) {
            // Update usage
            usageHistory.set(accessCode, {
                ...updatedHistory,
                uses: codeData.uses === Infinity ? Infinity : updatedHistory.uses - 1,
                lastUsed: now
            });

            res.json({ 
                success: true,
                type: codeData.type,
                usesLeft: updatedHistory.uses,
                description: codeData.description
            });
            return;
        }
    }
    
    res.json({ success: false });
});

app.post('/chat', async (req, res) => {
    const { message, accessCode } = req.body;
    
    // Verify access code again
    if (!accessCodes.has(accessCode)) {
        res.json({ success: false, error: 'Invalid access code' });
        return;
    }

    const codeData = accessCodes.get(accessCode);
    const history = usageHistory.get(accessCode);

    if (!history || (history.uses <= 0 && codeData.uses !== Infinity)) {
        res.json({ success: false, error: 'Code expired or out of uses' });
        return;
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

        // Update usage timestamp
        usageHistory.set(accessCode, {
            ...history,
            lastUsed: Date.now()
        });

        res.json({
            success: true,
            response: completion.choices[0].message.content,
            usesLeft: history.uses === Infinity ? 'Unlimited' : history.uses,
            type: codeData.type
        });
    } catch (error) {
        console.error('OpenAI API Error:', error);
        let errorMessage = 'Error communicating with ChatGPT';
        
        if (error.message.includes('insufficient_quota')) {
            errorMessage = 'API quota exceeded. Please try again later.';
        } else if (error.message.includes('model not found')) {
            errorMessage = 'Model access not available. Please check your API key permissions.';
        }
        
        res.json({
            success: false,
            error: errorMessage
        });
    }
});

// Endpoint to check code status
app.post('/check-status', (req, res) => {
    const { accessCode } = req.body;
    
    if (accessCodes.has(accessCode)) {
        const codeData = accessCodes.get(accessCode);
        const history = usageHistory.get(accessCode);
        
        if (history) {
            const timeLeft = codeData.cooldown ? 
                Math.max(0, codeData.cooldown - (Date.now() - history.lastReset)) : 0;
            
            res.json({
                success: true,
                usesLeft: history.uses,
                timeToReset: timeLeft,
                type: codeData.type,
                description: codeData.description
            });
            return;
        }
    }
    
    res.json({ success: false });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
    console.log('Using GPT-4-0125-preview model');
});
