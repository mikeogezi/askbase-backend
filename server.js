// TODO: Use transactions for multiple consecutive queries
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const Stripe = require('stripe');
const { PrismaClient } = require('@prisma/client');

const SECRET_KEY = 'your-secret-key';
const DB_PATH = path.join(__dirname, 'users.db');
const OPENAI_API_KEY = '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';
const STRIPE_SECRET_KEY = "sk_test_51GrL6gLRSbKrHZ7okKSRfteML7iozGLImfVjZ3ZNJbBznw6oCBUuJGDRCq3V0PzGTcg4LelrECDdJzRKDW0IDNTI00ydvBdSio";

const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY);
const prisma = new PrismaClient();

app.use(session({
  secret: SECRET_KEY, // replace with a strong secret
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 60000 } // 1 minute cookie expiry for this example, adjust as necessary
}));
app.use(cors());
app.use(flash());
app.use(cookieParser());
app.use((req, res, next) => {
  req.ajax = req.headers['x-requested-with'] === 'XMLHttpRequest';
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

app.get('/log-in', (req, res) => {
  res.render('login', { error: req.flash('loginError').lastAndPop(), referer: req.query.referer || req.query.next });
});

app.get('/sign-up', (req, res) => {
  res.render('signup', { error: req.flash('signupError').lastAndPop(), referer: req.query.referer || req.query.next});
});

app.get('/log-out', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/log-in');
});

app.get('/pay', (req, res) => {
  res.render('pay/main', { error: req.flash('payError').lastAndPop(), plan: req.query.plan, period: req.query.period });
});

app.get('/pay/start', (req, res) => {
  res.render('pay/begin', { error: req.flash('payError').lastAndPop(), plan: req.query.plan, period: req.query.period });
});

app.post('/pay/start', async (req, res) => {
  const { plan, period } = req.body;

  if (!verifyPaidPlan(plan)) {
    req.flash('payError', 'Invalid plan.');
    return res.redirect('/pay/start');
  }

  if (!verifyPeriod(period)) {
    req.flash('payError', 'Invalid subscription period.');
    return res.redirect('/pay/start');
  }

  res.redirect(`/pay?plan=${plan}&period=${period}`);
});

app.get('/pay/complete', (req, res) => {
  res.render('pay/complete', { error: req.flash('payError').lastAndPop() });
});

app.post('/sign-up', async (req, res) => {
  const { email, password } = req.body;
  const referer = req.query.referer || req.query.next || '/account';
  const hashedPassword = await bcrypt.hash(password, SALT);

  try {
    const user = await prisma.user.create({
      data: {
        email,
        hashedPassword,
      },
    });

    // On successful signup, generate token, set cookie, and redirect
    const token = jwt.sign({ email }, SECRET_KEY, { expiresIn: '30d' });
    res.cookie('auth_token', token, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
    res.redirect(referer);
  } catch (err) {
    console.error(err);
    req.flash('signupError', 'Error while signing up. Please try again.');
    res.redirect('/sign-up');
  }
});

app.post('/log-in', async (req, res) => {
  const { email, password } = req.body;
  const referer = req.query.referer || req.query.next || '/account';

  try {
    const user = await prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (!user || !await bcrypt.compare(password, user.hashedPassword)) {
      req.flash('loginError', 'Invalid email or password.');
      return res.redirect('/log-in');
    }

    // On successful login, generate token, set cookie, and redirect
    const token = jwt.sign({ email: user.email }, SECRET_KEY, { expiresIn: '30d' });
    res.cookie('auth_token', token, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
    res.redirect(referer);
  } catch (err) {
    console.error(err);
    req.flash('loginError', 'Error while logging in. Please try again.');
    res.redirect('/log-in');
  }
});

// Middleware function for JWT token verification
function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1] || req.cookies.auth_token;
  if (!token) {
    if (req.ajax) {
      return res.status(401).json({ error: 'Missing token' });
    } else {
      return res.redirect(`/log-in?next=${req.originalUrl}`);
    }
  }

  try {
    jwt.verify(token, SECRET_KEY);
    const decoded = jwt.decode(token);
    req.token = token;
    req.email = decoded.email;
    next(); // Move to the next middleware or route
  } catch (err) {
    if (req.ajax) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    } else {
      return res.redirect(`/log-in?next=${req.originalUrl}`);
    }
  }
}

app.get('/', (req, res) => {
  res.redirect('/account');
});

app.use('/account', verifyToken);
app.get('/account', async (req, res) => {
  const email = req.email;
  const user = await prisma.user.findUniqueOrThrow({
    where: {
      email,
    },
  });

  res.render('account', { error: req.flash('accountError').lastAndPop(), user: {...user, maxQueriesPerMonth: planMap[user.currentPlan].queries} });
});

app.use('/incrementQueryUsage', verifyToken);
app.all('/incrementQueryUsage', async (req, res) => {
  const email = req.email;

  const updatedUser = await prisma.user.update({
    where: {
      email,
    },
    data: {
      queryUsageThisMonth: { increment: 1 },
    },
  });

  res.json({ queryUsageThisMonth: updatedUser.queryUsageThisMonth });
});



// Redo /info endpoint with Prisma
app.use('/info', verifyToken);
app.get('/info', async (req, res) => {
  const email = req.email;

  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        email,
      },
    });

    delete user.hashedPassword;
    delete user.payments
    res.json({ user: {...user, maxQueriesPerMonth: planMap[user.currentPlan].queries} });
  } catch (err) {
    req.flash('infoError', 'Error while getting info. Please try again.');
    res.redirect('/sign-up');
  }
});

function verifyPeriod(period) {
  return period == 'monthly' || period == 'yearly';
}

function verifyPaidPlan(plan) {
  return plan == 'basic' || plan == 'pro';
}

const planMap = {
  basic: {
    period: {
      monthly: 10, 
      yearly: 7,  
    },
    queries: 1000,
  },
  pro: {
    period: {
      monthly: 20, 
      yearly: 14,
    },
    queries: 10000,
  },
  free: {
    period: {
      monthly: 0,
      yearly: 0,
    },
    queries: 100,
  },
};

Array.prototype.lastAndPop = function() {
  const last = this[this.length - 1];
  _ = this.pop();
  return last;
}

String.prototype.toTitleCase = function() {
  return this.charAt(0).toUpperCase() + this.slice(1);
}

app.use('/charge', verifyToken);
app.post('/charge', async (req, res) => {
  let { plan, period } = req.body;

  if (!verifyPaidPlan(plan)) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }

  if (!verifyPeriod(period)) {
    return res.status(400).json({ error: 'Invalid period.' });
  }

  const amount = planMap[plan].period[period] * 100; // Convert to cents
  const email = req.email;

  // TODO: Modify this to natively handle subscriptions with Stripe
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      automatic_payment_methods: {
        enabled: true,
      },
      receipt_email: email,
    });

    // Save the charge id to the database
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        email,
      },
    });

    await prisma.payment.create({
      data: {
        plan,
        period,
        amount,
        currency: paymentIntent.currency,
        stripeId: paymentIntent.id,
        user: {
          connect: {
            id: user.id,
          },
        },
      },
    });
    
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.log(err);
    res.status(400).json({ error: "Unable to process payment." });
  }
});

app.all('/ping', (req, res) => {
  res.json({ message: 'pong!' });
});

// TODO: Validate that the request is coming from stripe
app.post('/stripe-webhook', async (req, res) => {
  console.log('Received webhook');
  let event = req.body;

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;

        // Find user directly by the stripeId of the payment
        const userWithPayment = await prisma.payment.findUniqueOrThrow({
          where: {
            stripeId: paymentIntent.id,
          },
          select: {
            user: true,
          },
        });

        // Update user
        await prisma.user.update({
          where: {
            id: userWithPayment.user.id,
          },
          data: {
            currentPlan: plan,
            queryUsageThisMonth: 0,
          },
        });

        // Update payment as completed
        await prisma.payment.update({
          where: {
            stripeId: paymentIntent.id,
          },
          data: {
            completed: true,
            completedAt: new Date(),
          },
        });

        break;
      }
      default:
        console.warn(`Unhandled event type ${event.type}`);
    }

    // Acknowledge receipt of the event
    console.log(`Successfully processed webhook: ${event.id}`);
    res.json({ received: true });
  } catch (err) {
    console.error(`Error processing webhook: ${err}`);
    res.status(400).json({ error: "Unable to process webhook." });
  }
});

const PORT = 8080 || process.env.PORT;
let SALT;

async function main() {
  app.listen(PORT, async () => {
    SALT = await bcrypt.genSalt(10);
    console.log(`Server running on ${PORT}`);
  });
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })

