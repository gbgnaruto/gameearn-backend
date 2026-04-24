const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' })); 
app.use(express.json());

const PAYU_KEY = "tdbfnh";
// THE TRUE SALT (Fixed typos from original OCR)
const PAYU_SALT = "Lwn7GigYIPIp3M0Gi1KB0kXBlES1jXr2";

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

app.get('/', (req, res) => {
    res.send("GameEarnPro PayU API is Live!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Secure PayU Server running on port ${PORT}`);
});
