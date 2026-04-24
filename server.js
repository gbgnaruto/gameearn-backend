const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const app = express();

// Allow your Firebase app to talk to this server safely
app.use(cors({ origin: '*' })); 
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Helps read payment gateway signals

// Your PayU Test Credentials
const PAYU_KEY = "tdbfnh";
// THE TRUE SALT
const PAYU_SALT = "Lwn7GigYIPIp3M0Gi1KB0kXBlES1jXr2";

// ----------------------------------------------------
// ROUTE 1: Generate Secure Hash for PayU Checkout
// ----------------------------------------------------
app.post('/generate-hash', (req, res) => {
    const { txnid, amount, productinfo, firstname, email } = req.body;

    if (!txnid || !amount || !productinfo || !firstname || !email) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // Exactly 11 pipes (|||||||||||) between email and salt
    const hashString = `${PAYU_KEY}|${txnid}|${amount}|${productinfo}|${firstname}|${email}|||||||||||${PAYU_SALT}`;
    
    const hash = crypto.createHash('sha512').update(hashString).digest('hex');

    res.json({ hash: hash, key: PAYU_KEY });
});

// ----------------------------------------------------
// ROUTE 2: Catch PayU Success Signal (The Traffic Cop)
// ----------------------------------------------------
app.post('/success', (req, res) => {
    // Grab the match intel we attached to the URL before sending them to PayU
    const matchId = req.query.matchId;
    const uid = req.query.uid;
    const team = req.query.team || "NONE";
    
    // Redirect the player safely back to the app with a success badge
    res.redirect(`https://gameearnpro.web.app/?payment=success&matchId=${matchId}&uid=${uid}&team=${team}`);
});

// ----------------------------------------------------
// ROUTE 3: Catch PayU Failure Signal (The Traffic Cop)
// ----------------------------------------------------
app.post('/failure', (req, res) => {
    res.redirect(`https://gameearnpro.web.app/?payment=failed`);
});

// ----------------------------------------------------
// ROUTE 4: Server Health Check
// ----------------------------------------------------
app.get('/', (req, res) => {
    res.send("GameEarnPro PayU API + Traffic Cop is Live!");
});

// Start the engine
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Secure PayU Server running on port ${PORT}`);
});
