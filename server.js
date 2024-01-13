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
let stripePriceMap;

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

app.get('/subscription', (req, res) => {
  res.render('pay/main', { error: req.flash('payError').lastAndPop(), plan: req.query.plan, period: req.query.period });
});

app.get('/subscription/start', (req, res) => {
  res.render('pay/begin', { error: req.flash('payError').lastAndPop(), plan: req.query.plan, period: req.query.period });
});

app.post('/subscription/start', async (req, res) => {
  const { plan, period = 'yearly' } = req.body;

  if (!verifyPaidPlan(plan)) {
    req.flash('payError', 'Invalid plan.');
    return res.redirect('/subscription/start');
  }

  if (!verifyPeriod(period)) {
    req.flash('payError', 'Invalid subscription period.');
    return res.redirect('/subscription/start');
  }

  res.redirect(`/subscription?plan=${plan}&period=${period}`);
});

app.get('/subscription/complete', (req, res) => {
  res.render('pay/complete', { error: req.flash('payError').lastAndPop() });
});

app.post('/sign-up', async (req, res) => {
  const { email, password } = req.body;
  const referer = req.query.referer || req.query.next || '/account';
  const hashedPassword = await bcrypt.hash(password, SALT);

  try {
    const stripeCustomer = await stripe.customers.create({
      email,
    });

    const user = await prisma.user.create({
      data: {
        email,
        hashedPassword,
        stripeCustomerId: stripeCustomer.id,
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

async function initStripePriceMap() {
  const prices = await stripe.prices.list({
    lookup_keys: ['basic', 'pro'],
    expand: ['data.product']
  });
  const stripePriceMap = {};
  for (price of prices.data) {
    stripePriceMap[price.lookup_key] = price.id;
  }
  return stripePriceMap;
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

app.use('/subscription/cancel', verifyToken);
app.get('/subscription/cancel', async (req, res) => {
  const email = req.email;

  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        email,
      },
    });

    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    res.redirect('/account');
  } catch (error) {
    console.error(error);
    req.flash('accountError', 'Unable to cancel subscription.');
    return res.redirect('/account');
  }
});

app.use('/subscription/update', verifyToken);
app.get('/subscription/update', async (req, res) => {
  const { plan, period = 'yearly' } = req.query;
  const email = req.email;

  if (!verifyPaidPlan(plan)) {
    req.flash('accountError', 'Invalid plan.');
    return res.redirect('/account');
  }

  if (!verifyPeriod(period)) {
    req.flash('accountError', 'Invalid subscription period.');
    return res.redirect('/account');
  }

  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        email,
      },
    });

    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: false,
      items: [{
        id: subscription.items.data[0].id,
        price: stripePriceMap[plan],
      }],
    });

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        currentPlan: plan,
      },
    });

    res.redirect('/account');
  } catch (error) {
    console.error(error);
    req.flash('accountError', 'Unable to update subscription.');
    return res.redirect('/account');
  }
});

app.use('/subscription/charge', verifyToken);
app.post('/subscription/charge', async (req, res) => {
  const { plan, period = 'yearly' } = req.body;
  const email = req.email;

  if (!verifyPaidPlan(plan)) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }

  if (!verifyPeriod(period)) {
    return res.status(400).json({ error: 'Invalid subscription period.' });
  }

  const amount = planMap[plan].period[period] * 100;

  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        email,
      },
    });

    const subscription = await stripe.subscriptions.create({
      customer: user.stripeCustomerId,
      items: [{
        price: stripePriceMap[plan],
      }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        stripeSubscriptionId: subscription.id,
      },
    });

    await prisma.payment.create({
      data: {
        plan,
        period,
        amount,
        currency: 'usd',
        stripeId: subscription.latest_invoice.payment_intent.id,
        user: {
          connect: {
            id: user.id,
          },
        },
      },
    });

    res.send({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
    });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: 'Unable to create subscription.' });
  }
});

// TODO: Validate that the request is coming from stripe
app.post('/stripe-webhook', async (req, res) => {
  console.log('Received webhook');
  let event = req.body;
  const dataObject = event.data.object;

  try {
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        if (dataObject.billing_reason == 'subscription_create') {
          const paymentIntentId = dataObject.payment_intent;
          const subscriptionId = dataObject.subscription;

          // Find user directly by the stripeId of the payment
          const userWithPayment = await prisma.payment.findUniqueOrThrow({
            where: {
              stripeId: paymentIntentId,
            },
            select: {
              user: true,
            },
          });

          await prisma.user.update({
            where: {
              id: userWithPayment.user.id,
            },
            data: {
              currentPlan: plan,
            },
          });

          // Update payment as completed
          await prisma.payment.update({
            where: {
              stripeId: paymentIntentId,
            },
            data: {
              completed: true,
              completedAt: new Date(),
            },
          });

          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          const subscription = await stripe.subscriptions.update(subscriptionId, {
            default_payment_method: paymentIntent.payment_method,
          });

          break;
        } else if (dataObject.billing_reason == 'subscription_update') {
          // TODO: Modify user benefits when upgraded, downgraded or cancelled
        } else if (dataObject.billing_reason == 'subscription_cycle') {
        }
      }
      case 'invoice.payment_failed':
        // If the payment fails or the customer does not have a valid payment method,
        //  an invoice.payment_failed event is sent, the subscription becomes past_due.
        // Use this webhook to notify your user that their payment has
        // failed and to retrieve new card details.
        break;
      case 'invoice.finalized':
        // If you want to manually send out invoices to your customers
        // or store them locally to reference to avoid hitting Stripe rate limits.
        break;
      case 'customer.subscription.deleted':
        if (event.request != null) {
          // handle a subscription cancelled by your request
          // from above.
        } else {
          // handle subscription cancelled automatically based
          // upon your subscription settings.
        }
        break;
      case 'customer.subscription.trial_will_end':
        // Send notification to your user that the trial will end
        break;
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

app.all('/ping', (req, res) => {
  res.json({ message: 'pong!' });
});

const PORT = 8080 || process.env.PORT;
let SALT;

async function main() {
  app.listen(PORT, async () => {
    SALT = await bcrypt.genSalt(10);
    stripePriceMap = await initStripePriceMap();
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

