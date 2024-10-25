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
    apiKey: process.env.Apikey.trim() // Ensure no whitespace
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Store valid access codes and their usage
const accessCodes = new Map();

// Initialize some access codes (you can modify or remove these)
accessCodes.set('UNLIMITED123', { uses: Infinity });
accessCodes.set('TEST5', { uses: 5 });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/verify-access', (req, res) => {
    const { accessCode } = req.body;
    
    if (accessCodes.has(accessCode)) {
        const codeData = accessCodes.get(accessCode);
        if (codeData.uses > 0) {
            res.json({ success: true });
            return;
        }
    }
    
    res.json({ success: false });
});

app.post('/chat', async (req, res) => {
    const { message, accessCode } = req.body;
    
    // Verify access code
    if (!accessCodes.has(accessCode)) {
        res.json({ success: false, error: 'Invalid access code' });
        return;
    }

    const codeData = accessCodes.get(accessCode);
    if (codeData.uses <= 0) {
        res.json({ success: false, error: 'Access code expired' });
        return;
    }

    // Decrease uses if not unlimited
    if (codeData.uses !== Infinity) {
        codeData.uses--;
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

        res.json({
            success: true,
            response: completion.choices[0].message.content
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present (length: ' + process.env.Apikey.length + ')' : 'Missing');
    console.log('Using GPT-4-0125-preview model (4-mini)');
});
