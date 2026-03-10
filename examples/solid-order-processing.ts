/**
 * SOLID-Compliant Order Processing Example
 *
 * Demonstrates:
 * - Single Responsibility Principle: Each class has one reason to change
 * - Open/Closed Principle: New order types can be added without modifying existing code
 * - Liskov Substitution Principle: All strategies can be used interchangeably
 * - Interface Segregation Principle: Focused, small interfaces
 * - Dependency Inversion Principle: Depends on abstractions, not concretions
 */

// ============================================
// Interfaces (Abstractions)
// ============================================

interface Order {
  id: string;
  type: OrderType;
  status: OrderStatus;
  customerEmail?: string;
  shippingAddress?: string;
  // Add other order properties as needed
}

enum OrderType {
  DIGITAL = 'digital',
  PHYSICAL = 'physical',
  SUBSCRIPTION = 'subscription',
}

enum OrderStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  SHIPPED = 'shipped',
  ACTIVE = 'active',
}

/**
 * Strategy Interface - defines the contract for all order processing strategies
 * This follows the Interface Segregation Principle
 */
interface OrderProcessingStrategy {
  process(order: Order): void;
}

/**
 * Logger Interface - allows for different logging implementations
 * This follows the Dependency Inversion Principle
 */
interface Logger {
  log(message: string): void;
}

// ============================================
// Concrete Implementations
// ============================================

// Concrete Logger implementation
class ConsoleLogger implements Logger {
  log(message: string): void {
    console.log(message);
  }
}

// Digital Order Strategy
class DigitalOrderStrategy implements OrderProcessingStrategy {
  constructor(private logger: Logger, private emailService: EmailService) {}

  process(order: Order): void {
    this.logger.log(`Processing digital order: ${order.id}`);

    // Send email with download link
    this.emailService.sendEmail({
      to: order.customerEmail!,
      subject: 'Your digital order is ready',
      body: 'Click here to download your item',
    });

    order.status = OrderStatus.DELIVERED;
  }
}

// Physical Order Strategy
class PhysicalOrderStrategy implements OrderProcessingStrategy {
  constructor(private logger: Logger, private shippingService: ShippingService) {}

  process(order: Order): void {
    this.logger.log(`Processing physical order: ${order.id}`);

    // Create shipping label
    const label = this.shippingService.createLabel({
      address: order.shippingAddress!,
      orderId: order.id,
    });

    this.logger.log(`Shipping label created: ${label.trackingNumber}`);

    order.status = OrderStatus.SHIPPED;
  }
}

// Subscription Order Strategy
class SubscriptionOrderStrategy implements OrderProcessingStrategy {
  constructor(private logger: Logger, private subscriptionService: SubscriptionService) {}

  process(order: Order): void {
    this.logger.log(`Processing subscription order: ${order.id}`);

    // Activate subscription
    this.subscriptionService.activate({
      orderId: order.id,
      customerEmail: order.customerEmail!,
    });

    order.status = OrderStatus.ACTIVE;
  }
}

// ============================================
// Support Services (External Dependencies)
// ============================================

interface EmailService {
  sendEmail(params: { to: string; subject: string; body: string }): void;
}

interface ShippingService {
  createLabel(params: { address: string; orderId: string }): { trackingNumber: string };
}

interface SubscriptionService {
  activate(params: { orderId: string; customerEmail: string }): void;
}

// Mock implementations (in production, these would be real services)
class MockEmailService implements EmailService {
  sendEmail(params: { to: string; subject: string; body: string }): void {
    console.log(`[Email Service] Sending email to ${params.to}: ${params.subject}`);
  }
}

class MockShippingService implements ShippingService {
  createLabel(params: { address: string; orderId: string }): { trackingNumber: string } {
    const trackingNumber = `TRK-${params.orderId}-${Date.now()}`;
    console.log(`[Shipping Service] Creating label for ${params.address}`);
    return { trackingNumber };
  }
}

class MockSubscriptionService implements SubscriptionService {
  activate(params: { orderId: string; customerEmail: string }): void {
    console.log(`[Subscription Service] Activating subscription for ${params.customerEmail}`);
  }
}

// ============================================
// Strategy Factory (Single Responsibility)
// ============================================

/**
 * Factory responsible for creating the appropriate strategy based on order type
 * This follows the Open/Closed Principle - new strategies can be added without modifying this class
 */
class OrderStrategyFactory {
  private strategies = new Map<OrderType, OrderProcessingStrategy>();

  constructor(
    logger: Logger,
    emailService: EmailService,
    shippingService: ShippingService,
    subscriptionService: SubscriptionService,
  ) {
    // Register all available strategies
    this.strategies.set(OrderType.DIGITAL, new DigitalOrderStrategy(logger, emailService));
    this.strategies.set(
      OrderType.PHYSICAL,
      new PhysicalOrderStrategy(logger, shippingService),
    );
    this.strategies.set(
      OrderType.SUBSCRIPTION,
      new SubscriptionOrderStrategy(logger, subscriptionService),
    );
  }

  getStrategy(orderType: OrderType): OrderProcessingStrategy {
    const strategy = this.strategies.get(orderType);
    if (!strategy) {
      throw new Error(`No strategy found for order type: ${orderType}`);
    }
    return strategy;
  }
}

// ============================================
// Order Processor (Context)
// ============================================

/**
 * Order Processor - the context that uses strategies
 * This follows the Single Responsibility Principle - only handles order processing orchestration
 * And Dependency Inversion Principle - depends on abstractions (Factory, Logger)
 */
class OrderProcessor {
  constructor(
    private strategyFactory: OrderStrategyFactory,
    private logger: Logger,
  ) {}

  processOrder(order: Order): Order {
    this.logger.log(`Starting order processing for order: ${order.id}`);

    // Get the appropriate strategy and process
    const strategy = this.strategyFactory.getStrategy(order.type);
    strategy.process(order);

    this.logger.log(`Order processed successfully: ${order.id} (Status: ${order.status})`);

    return order;
  }
}

// ============================================
// Usage Example
// ============================================

export function demonstrateSOLIDOrderProcessing() {
  // Setup dependencies (could be injected via DI container in production)
  const logger: Logger = new ConsoleLogger();
  const emailService: EmailService = new MockEmailService();
  const shippingService: ShippingService = new MockShippingService();
  const subscriptionService: SubscriptionService = new MockSubscriptionService();

  // Create strategy factory with all dependencies
  const strategyFactory = new OrderStrategyFactory(
    logger,
    emailService,
    shippingService,
    subscriptionService,
  );

  // Create order processor
  const orderProcessor = new OrderProcessor(strategyFactory, logger);

  // Create test orders
  const digitalOrder: Order = {
    id: 'ORD-001',
    type: OrderType.DIGITAL,
    status: OrderStatus.PENDING,
    customerEmail: 'customer@example.com',
  };

  const physicalOrder: Order = {
    id: 'ORD-002',
    type: OrderType.PHYSICAL,
    status: OrderStatus.PENDING,
    customerEmail: 'customer@example.com',
    shippingAddress: '123 Main St, City, Country',
  };

  const subscriptionOrder: Order = {
    id: 'ORD-003',
    type: OrderType.SUBSCRIPTION,
    status: OrderStatus.PENDING,
    customerEmail: 'customer@example.com',
  };

  // Process orders
  console.log('=== Processing Digital Order ===');
  orderProcessor.processOrder(digitalOrder);

  console.log('\n=== Processing Physical Order ===');
  orderProcessor.processOrder(physicalOrder);

  console.log('\n=== Processing Subscription Order ===');
  orderProcessor.processOrder(subscriptionOrder);

  return {
    digitalOrder,
    physicalOrder,
    subscriptionOrder,
  };
}

// ============================================
// Benefits of this SOLID approach:
// ============================================

/**
 * 1. Single Responsibility Principle
 *    - Each class has one reason to change
 *    - DigitalOrderStrategy only handles digital orders
 *    - OrderStrategyFactory only creates strategies
 *    - OrderProcessor only orchestrates processing
 *
 * 2. Open/Closed Principle
 *    - New order types can be added by creating new strategy classes
 *    - No existing code needs to be modified
 *    - Example: Adding a GiftCardStrategy without changing OrderProcessor
 *
 * 3. Liskov Substitution Principle
 *    - All OrderProcessingStrategy implementations are interchangeable
 *    - The OrderProcessor can use any strategy without knowing the concrete type
 *
 * 4. Interface Segregation Principle
 *    - Small, focused interfaces (OrderProcessingStrategy, Logger, etc.)
 *    - Classes only implement methods they need
 *
 * 5. Dependency Inversion Principle
 *    - High-level modules (OrderProcessor) depend on abstractions (interfaces)
 *    - Low-level modules (DigitalOrderStrategy, etc.) implement abstractions
 *    - Both depend on interfaces, not concrete implementations
 *
 * Additional Benefits:
 * - Testable: Each component can be unit tested in isolation
 * - Maintainable: Changes are isolated to specific classes
 * - Extensible: New features can be added without refactoring existing code
 * - Type-safe: TypeScript catches errors at compile time
 * - Flexible: Dependencies can be swapped (e.g., MockLogger vs ProdLogger)
 */

// Run demonstration
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateSOLIDOrderProcessing();
}
