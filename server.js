const express = require('express');
const path = require('path');
const app = express();

// Import OpenAI
const OpenAI = require('openai');

// Initialize OpenAI with API key from environment variable
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
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
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: message }]
        });

        res.json({
            success: true,
            response: completion.choices[0].message.content
        });
    } catch (error) {
        console.error('OpenAI API Error:', error);
        res.json({
            success: false,
            error: 'Error communicating with ChatGPT'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
