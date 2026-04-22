const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your Firebase app to talk to this server
app.use(cors({ origin: '*' }));
app.use(express.json());

// Your Secret API Key (Safe here, hidden from players)
const UPI_API_KEY = "c19d46b5-ed8e-4e36-907a-8362e056bb0d";

// The Route your frontend will call
app.post('/create-payment', async (req, res) => {
    try {
        const payload = {
            key: UPI_API_KEY,
            client_txn_id: req.body.client_txn_id,
            amount: req.body.amount,
            p_info: req.body.p_info,
            customer_name: req.body.customer_name,
            customer_email: "agent@gameearnpro.com",
            customer_mobile: "9999999999",
            redirect_url: req.body.redirect_url,
            udf1: "GameEarnPro",
            udf2: "Esports"
        };

        // Node.js talking securely to UPIGateway
        const gatewayResponse = await fetch("https://api.upigateway.com/api/create_order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await gatewayResponse.json();
        
        // Send the result back to your frontend
        res.json(data);

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ status: false, msg: "Server communication failed." });
    }
});

app.listen(PORT, () => {
    console.log(`GameEarnPro Backend running securely on port ${PORT}`);
});
