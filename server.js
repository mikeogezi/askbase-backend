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
const cron = require('node-cron');
const { PrismaClient, Prisma } = require('@prisma/client');

const SECRET_KEY = process.env.SECRET_KEY || 'a82f7893280a01ada514b37f412a4e78';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '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';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ||  'sk_test_51GrL6gLRSbKrHZ7okKSRfteML7iozGLImfVjZ3ZNJbBznw6oCBUuJGDRCq3V0PzGTcg4LelrECDdJzRKDW0IDNTI00ydvBdSio';
const STRIPE_SIGNING_SECRET = process.env.STRIPE_SIGNING_SECRET || 'whsec_e4d12a345072f49037b15429a1fb9ab85260165949395d45454cf1310070491b';

const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY);
const prisma = new PrismaClient();
let stripePriceMap;

const PORT = 8080 || process.env.PORT;
app.locals.STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || 'pk_test_51GrL6gLRSbKrHZ7oQXVesBOd4EQhqYOYkVu0NVJFJa2AS2aLuJbyAyTgcmcpgyWlvAYJyZAuAoIiUpr476yi46gM00bHiFr6y2';
app.locals.HOST = process.env.HOST || `http://localhost:${PORT}`;

app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));
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

// Every first day of the month, reset query usage for all users
cron.schedule('0 0 1 * *', async () => {
  await resetSubscriptionUsage();
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

function getEmailOrNull(req) {
  const token = req.headers['authorization']?.split(' ')[1] || req.cookies.auth_token;
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.decode(token);
    return decoded.email;
  } catch (err) {
    return null;
  }
}

async function resetSubscriptionUsage() {
  await prisma.user.updateMany({
    data: {
      queryUsageThisMonth: 0,
    },
  });
}

Array.prototype.lastAndPop = function() {
  const last = this[this.length - 1];
  _ = this.pop();
  return last;
}

String.prototype.toTitleCase = function() {
  return this.charAt(0).toUpperCase() + this.slice(1);
}

Date.prototype.toCustomDateString = function() {
  const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  return this.toLocaleDateString('en-US', options).replace(',', ',');
};

app.get('/terms', (req, res) => {
  res.render('terms');
});

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

app.use('/subscription*', verifyToken);

app.get('/subscription', (req, res) => {
  const user = prisma.user.findUnique({
    where: {
      email: req.email,
    },
  });

  if (user.stripeSubscriptionId) {
    res.redirect('/account');
  } else {
    res.render('pay/main', { error: req.flash('payError').lastAndPop(), plan: req.query.plan, period: req.query.period });
  }
});

app.get('/subscription/start', async (req, res) => {
  const user = await prisma.user.findUnique({
    email: req.email,
  });

  if (user.renewsAt || user.expiresAt) {
    return res.redirect('/account')
  }

  res.render('pay/begin', { 
    error: req.flash('payError').lastAndPop(), 
    plan: req.query.plan, 
    period: req.query.period, 
    planMap,
    hidePlanPeriods: true
  });
});

app.post('/subscription/start', async (req, res) => {
  const { plan, period = 'monthly' } = req.body;

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

app.get('/subscription/cancel', async (req, res) => {
  const email = req.email;

  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        email,
      },
    });

    if (user.currentPlan == 'free') {
      req.flash('accountError', 'You are already on the free plan.');
      return res.redirect('/account');
    }

    // await stripe.subscriptions.cancel(user.stripeSubscriptionId)
    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        expiresAt: new Date(subscription.current_period_end * 1_000),
        renewsAt: null,
      },
    });

    res.redirect('/account');
  } catch (error) {
    console.error(error);
    req.flash('accountError', 'Unable to cancel subscription.');
    return res.redirect('/account');
  }
});

app.get('/subscription/update', async (req, res) => {
  const { plan, period = 'monthly' } = req.query;
  const email = req.email;

  if (plan == 'free') {
    return res.redirect('/subscription/cancel');
  }

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

    if (!user.stripeSubscriptionId) {
      return res.redirect(`/subscription/start?plan=${plan}`);
    }

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
        expiresAt: null,
        renewsAt: new Date(subscription.current_period_end * 1_000),
      },
    });

    res.redirect('/account');
  } catch (error) {
    console.error(error);
    req.flash('accountError', 'Unable to update subscription.');
    return res.redirect('/account');
  }
});

app.post('/subscription/charge', async (req, res) => {
  const { plan, period = 'monthly' } = {...req.body, ...req.query};
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
      // trial_end or trial_end_days for a free trial
    });

    await prisma.$transaction([
      prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          stripeSubscriptionId: subscription.id,
        },
      }),
      prisma.payment.create({
        data: {
          plan,
          period,
          amount,
          stripeId: subscription.latest_invoice.payment_intent.id,
          user: {
            connect: {
              id: user.id,
            },
          },
        },
      }),
    ], {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
    
    res.send({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
    });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: 'Unable to create subscription.' });
  }
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

    await prisma.user.update({
      where: {
        email,
      },
      data: {
        lastLogin: new Date(),
      },
    });

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

app.get('/', async (req, res) => {
  const email = await getEmailOrNull(req);
  const user = email ? await prisma.user.findUnique({
    where: {
      email,
    },
  }) : null;
  res.render('landing', { hidePlanPeriods: true, planMap, user });
});

app.get('/plans', (req, res) => {
  res.render('plans');
});

app.use('/account', verifyToken);
app.get('/account', async (req, res) => {
  const email = req.email;
  let user;

  try {
    user = await prisma.user.findUniqueOrThrow({
      where: {
        email,
      },
    });
  } catch (err) {
    console.error(err);
    // NB: Using the loginError flash message instead of accountError for since we're redirecting to the login page
    req.flash('loginError', 'Unable to retrieve account info. Please log in again.');
    return res.redirect('/log-in');
  }

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
    console.error(err);
    res.status(400).json({ error: 'Unable to retrieve user info.' });
  }
});

function verifyPeriod(period) {
  return period == 'monthly' // || period == 'yearly';
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
  free: {
    period: {
      monthly: 0,
      yearly: 0,
    },
    queries: 100,
    benefits: [
      "100 queries per month",
      "Access to basic features",
    ],
  },
  basic: {
    period: {
      monthly: 10,
      yearly: 7,
    },
    queries: 1_000,
    benefits: [
      "1,000 queries per month",
      "Community support",
      "GPT-3.5",
    ],
  },
  pro: {
    period: {
      monthly: 20,
      yearly: 14,
    },
    queries: 10_000,
    benefits: [
      "10,000 queries per month",
      "Priority support",
      "GPT-4",
    ],
  },
};

// TODO: Validate that the request is coming from stripe
app.post('/stripe-webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, signature, STRIPE_SIGNING_SECRET);
  } catch (err) {
    console.error(`Error verifying webhook: ${err}`);
    return res.status(400).json({ error: "Unable to verify the webhook's authenticity" });
  }

  console.log(`Received webhook of ${event.type} from ${req.ip}`);

  try {
    const dataObject = event.data.object;
    const paymentIntentId = dataObject.payment_intent;
    const subscriptionId = dataObject.subscription;
    let subscription, user;

    if (subscriptionId) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice.payment_intent'],
      });
  
      user = await prisma.user.findUniqueOrThrow({
        where: {
          stripeCustomerId: subscription.customer,
        },
      });
    }

    switch (event.type) {
      case 'invoice.payment_succeeded': {
        if (dataObject.billing_reason == 'subscription_create') {
          // Find user directly by the stripeId of the payment
          const plan = subscription.items.data[0].price.lookup_key;

          await prisma.$transaction([
            prisma.payment.update({
              where: {
                stripeId: paymentIntentId,
              },
              data: {
                completed: true,
                completedAt: new Date(),
                status: 'succeeded',
              },
            }),
            prisma.user.update({
              where: {
                id: user.id,
              },
              data: {
                currentPlan: plan,
                expiresAt: null,
                renewsAt: new Date(subscription.current_period_end * 1_000),
              },
            }),
          ]);

          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          await stripe.subscriptions.update(subscriptionId, {
            default_payment_method: paymentIntent.payment_method,
          });
        } else if (dataObject.billing_reason == 'subscription_update') {
          // TODO: Modify user benefits when upgraded, downgraded or cancelled
          // Possible statuses: incomplete, incomplete_expired, trialing, active, past_due, canceled, or unpaid.
          if (subscription.status == 'canceled') {
            await prisma.user.update({
              where: {
                id: user.id,
              },
              data: {
                currentPlan: 'free',
                expiresAt: new Date(subscription.current_period_end * 1_000),
                renewsAt: null,
              },
            });
          } else if (subscription.status == 'active') {
            const plan = subscription.items.data[0].price.lookup_key; // Assuming plan is determined by lookup_key

            await prisma.user.update({
              where: { 
                id: user.id 
              },
              data: { 
                currentPlan: plan,
                expiresAt: null,
                renewsAt: new Date(subscription.current_period_end * 1_000),
              },
            });
          } else {
            console.error(`Unhandled subscription status ${subscription.status}`);
          }
        } else if (dataObject.billing_reason == 'subscription_cycle') {
          const amount = subscription.items.data[0].plan.amount;
          const plan = subscription.items.data[0].price.lookup_key;
          const currency = subscription.items.data[0].plan.currency;
          const period = subscription.items.data[0].plan.interval == 'year' ? 'yearly' : 'monthly';

          await prisma.payment.create({
            data: {
              plan,
              amount,
              currency,
              period,
              status: 'succeeded',
              completed: true,
              completedAt: new Date(),
              stripeId: subscription.latest_invoice.payment_intent.id,
              user: {
                connect: {
                  id: user.id,
                },
              },
              isAutoRenewal: true,
            },
          });

          await prisma.user.update({
            where: {
              id: user.id,
            },
            data: {
              expiresAt: null,
              renewsAt: new Date(subscription.current_period_end * 1_000),
            },
          });
        }
        break;
      }
      case 'invoice.payment_failed': {
        // If the payment fails or the customer does not have a valid payment method,
        //  an invoice.payment_failed event is sent, the subscription becomes past_due.
        // Use this webhook to notify your user that their payment has
        // failed and to retrieve new card details.
        // TODO: Create a failure status for failed payments
        await prisma.payment.update({
          where: {
            stripeId: paymentIntentId,
          },
          data: {
            completed: true,
            completedAt: new Date(),
            status: 'failed',
          },
        });

        break;
      }
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

