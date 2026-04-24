const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const app = express();

// Allow your Firebase app to talk to this server safely
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Your PayU Test Credentials
const PAYU_KEY = "tdbfnh";
const PAYU_SALT = "Lwn7GigYIPlp3M0Gi1KBOkXBIES1jXr2";

app.post('/generate-hash', (req, res) => {
    const { txnid, amount, productinfo, firstname, email } = req.body;

    if (!txnid || !amount || !productinfo || !firstname || !email) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // EXACTLY 10 PIPES between email and salt to perfectly match PayU API
    const hashString = `${PAYU_KEY}|${txnid}|${amount}|${productinfo}|${firstname}|${email}||||||||||${PAYU_SALT}`;
    
    // Encrypt using SHA-512
    const hash = crypto.createHash('sha512').update(hashString).digest('hex');

    res.json({ hash: hash, key: PAYU_KEY });
});

// A simple health check to see if the server is awake
app.get('/', (req, res) => {
    res.send("GameEarnPro PayU API is Live!");
});

// The port Render will assign
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Secure PayU Server running on port ${PORT}`);
});
