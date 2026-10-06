const express = require('express');

const {
  getMySubscriptions,
  pauseMySubscription,
  resumeMySubscription,
  cancelMySubscription,
  updateMySubscriptionCard,
  getSubscriptions,
  getSubscriptionOccurrences,
  getSubscriptionById,
  adminPauseSubscription,
  adminResumeSubscription,
  adminCancelSubscription
} = require('../controllers/subscription.controller');
const { protect, restrictTo } = require('../middlewares/protect.middleware');
const validate = require('../middlewares/validate.middleware');
const { paymentLimiter } = require('../middlewares/rateLimit.middleware');
const {
  updateSubscriptionCardSchema,
  emptySubscriptionActionSchema
} = require('../validations/subscription.validation');

const subscriptionRouter = express.Router();

// Literal route first so "my" is never interpreted as an ObjectId.
subscriptionRouter.get('/my', protect, getMySubscriptions);

// Customer-owned actions. Each controller scopes its query by user as a second
// line of defence; no request body can alter server-managed schedule/payment data.
subscriptionRouter.patch('/:id/pause', protect, validate(emptySubscriptionActionSchema), pauseMySubscription);
subscriptionRouter.patch('/:id/resume', protect, validate(emptySubscriptionActionSchema), resumeMySubscription);
subscriptionRouter.patch('/:id/cancel', protect, validate(emptySubscriptionActionSchema), cancelMySubscription);
subscriptionRouter.patch(
  '/:id/payment-method',
  paymentLimiter,
  protect,
  validate(updateSubscriptionCardSchema),
  updateMySubscriptionCard
);

// Admin collection/detail and action routes. Action literals are declared
// before the dynamic GET /:id route and auth always precedes restrictTo.
subscriptionRouter.get('/', protect, restrictTo('admin'), getSubscriptions);
// Literal route, declared before GET /:id so "occurrences" is never read as an id.
subscriptionRouter.get('/occurrences', protect, restrictTo('admin'), getSubscriptionOccurrences);
subscriptionRouter.patch(
  '/:id/admin-pause',
  protect,
  restrictTo('admin'),
  validate(emptySubscriptionActionSchema),
  adminPauseSubscription
);
subscriptionRouter.patch(
  '/:id/admin-resume',
  protect,
  restrictTo('admin'),
  validate(emptySubscriptionActionSchema),
  adminResumeSubscription
);
subscriptionRouter.patch(
  '/:id/admin-cancel',
  protect,
  restrictTo('admin'),
  validate(emptySubscriptionActionSchema),
  adminCancelSubscription
);
subscriptionRouter.get('/:id', protect, restrictTo('admin'), getSubscriptionById);

module.exports = subscriptionRouter;
