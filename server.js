require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');

const app = express();

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static('public'));

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => {
    console.log('Successfully connected to MongoDB.');
    console.log('Database: bend-the-bar');
})
.catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1); // Exit if cannot connect to database
});

// Handle MongoDB connection events
mongoose.connection.on('error', err => {
    console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
    console.log('MongoDB disconnected');
});

// Handle application termination
process.on('SIGINT', async () => {
    try {
        await mongoose.connection.close();
        console.log('MongoDB connection closed through app termination');
        process.exit(0);
    } catch (err) {
        console.error('Error during MongoDB disconnection:', err);
        process.exit(1);
    }
});

// Payment Schema
const paymentSchema = new mongoose.Schema({
    razorpay_payment_id: {
        type: String,
        required: [true, 'Payment ID is required'],
        unique: true,
        index: true
    },
    razorpay_order_id: {
        type: String,
        required: [true, 'Order ID is required'],
        index: true
    },
    razorpay_signature: {
        type: String,
        required: [true, 'Signature is required']
    },
    plan_type: {
        type: String,
        required: [true, 'Plan type is required'],
        enum: {
            values: ['Strength Training', 'Cardio'],
            message: 'Plan type must be either Strength Training or Cardio'
        },
        index: true
    },
    amount: {
        type: Number,
        required: [true, 'Amount is required'],
        min: [700, 'Amount must be at least ₹700'],
        max: [900, 'Amount must not exceed ₹900']
    },
    status: {
        type: String,
        required: [true, 'Status is required'],
        enum: {
            values: ['pending', 'success', 'failed', 'refunded', 'authorized'],
            message: 'Invalid payment status'
        },
        default: 'pending',
        index: true
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        trim: true,
        lowercase: true,
        match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email address'],
        index: true
    },
    created_at: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    updated_at: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true // Automatically manage createdAt and updatedAt
});

// Add compound indexes for common queries
paymentSchema.index({ status: 1, created_at: -1 }); // For querying recent payments by status
paymentSchema.index({ plan_type: 1, status: 1 }); // For querying payments by plan and status
paymentSchema.index({ email: 1, created_at: -1 }); // For querying user's payment history

// Add pre-save middleware to validate amount based on plan type
paymentSchema.pre('save', function(next) {
    if (this.plan_type === 'Strength Training' && this.amount !== 700) {
        next(new Error('Strength Training plan must cost ₹700'));
    } else if (this.plan_type === 'Cardio' && this.amount !== 900) {
        next(new Error('Cardio plan must cost ₹900'));
    }
    next();
});

// Add method to check if payment is valid
paymentSchema.methods.isValid = function() {
    return this.status === 'success' || this.status === 'authorized';
};

// Add static method to find recent successful payments
paymentSchema.statics.findRecentSuccessful = function(limit = 10) {
    return this.find({ status: 'success' })
        .sort({ created_at: -1 })
        .limit(limit);
};

const Payment = mongoose.model('Payment', paymentSchema);

// Create indexes
Payment.createIndexes()
    .then(() => console.log('Payment indexes created successfully'))
    .catch(err => console.error('Error creating indexes:', err));

// Email Configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Add API prefix to all routes
const router = express.Router();

// Move all existing routes under /api
router.post('/verify-payment', async (req, res) => {
    try {
        const {
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_signature,
            plan_type,
            amount,
            email
        } = req.body;

        // Validate required fields
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        // Verify signature
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        const isAuthentic = expectedSignature === razorpay_signature;

        if (isAuthentic) {
            // Save payment details with email
            const payment = new Payment({
                razorpay_payment_id,
                razorpay_order_id,
                razorpay_signature,
                plan_type,
                amount,
                email,
                status: 'success'
            });

            try {
                await payment.save();
            } catch (error) {
                if (error.code === 11000) {
                    return res.status(400).json({
                        success: false,
                        message: 'Payment already processed'
                    });
                }
                throw error;
            }

            // Send confirmation email
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: email,
                subject: 'Welcome to Bend The Bar Gym!',
                html: `
                    <h1>Payment Successful!</h1>
                    <p>Thank you for joining Bend The Bar Gym.</p>
                    <p>Plan: ${plan_type}</p>
                    <p>Amount: ₹${amount}</p>
                    <p>Payment ID: ${razorpay_payment_id}</p>
                `
            };

            await transporter.sendMail(mailOptions);

            res.json({
                success: true,
                message: 'Payment verified successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Payment verification failed'
            });
        }
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

router.post('/webhook', async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const signature = req.headers['x-razorpay-signature'];

        const shasum = crypto.createHmac('sha256', webhookSecret);
        shasum.update(JSON.stringify(req.body));
        const digest = shasum.digest('hex');

        if (signature === digest) {
            const event = req.body;

            switch (event.event) {
                case 'payment.authorized':
                    // Handle successful payment
                    await Payment.findOneAndUpdate(
                        { razorpay_payment_id: event.payload.payment.entity.id },
                        { status: 'authorized' }
                    );
                    break;

                case 'payment.failed':
                    // Handle failed payment
                    await Payment.findOneAndUpdate(
                        { razorpay_payment_id: event.payload.payment.entity.id },
                        { status: 'failed' }
                    );
                    break;

                case 'refund.processed':
                    // Handle refund
                    await Payment.findOneAndUpdate(
                        { razorpay_payment_id: event.payload.payment.entity.id },
                        { status: 'refunded' }
                    );
                    break;
            }

            res.json({ status: 'ok' });
        } else {
            res.status(400).json({ error: 'Invalid signature' });
        }
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/payment-status/:paymentId', async (req, res) => {
    try {
        const payment = await Payment.findOne({
            razorpay_payment_id: req.params.paymentId
        });

        if (payment) {
            res.json({
                success: true,
                status: payment.status,
                plan_type: payment.plan_type,
                amount: payment.amount
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Payment not found'
            });
        }
    } catch (error) {
        console.error('Payment status error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

router.get('/payment-stats', async (req, res) => {
    try {
        const stats = await Payment.aggregate([
            {
                $group: {
                    _id: '$plan_type',
                    total: { $sum: 1 },
                    totalAmount: { $sum: '$amount' },
                    successCount: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'success'] }, 1, 0]
                        }
                    }
                }
            }
        ]);

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error fetching payment stats:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching payment statistics'
        });
    }
});

router.get('/recent-payments', async (req, res) => {
    try {
        const payments = await Payment.find()
            .sort({ created_at: -1 })
            .limit(10)
            .select('razorpay_payment_id plan_type amount status created_at email');

        res.json({
            success: true,
            payments
        });
    } catch (error) {
        console.error('Error fetching recent payments:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching recent payments'
        });
    }
});

// Mount the router
app.use('/api', router);

// Serve static files
app.use(express.static('.'));

// Handle 404
app.use((req, res) => {
    res.status(404).send('Not Found');
});

// Export the Express API
module.exports = app;

// Only start the server if not in Vercel environment
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
} 