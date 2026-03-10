/**
 * Order Processing - Refactored using SOLID Principles
 *
 * This implementation follows:
 * - Single Responsibility Principle: Each strategy handles one order type
 * - Open/Closed Principle: New order types can be added without modifying existing code
 * - Liskov Substitution Principle: All strategies are interchangeable
 * - Interface Segregation Principle: Focused interfaces for specific behaviors
 * - Dependency Inversion Principle: High-level module depends on abstractions
 */

// ============================================================================
// Interfaces (Abstraction Layer)
// ============================================================================

/**
 * Represents the possible statuses an order can have
 */
export type OrderStatus =
  | 'pending'
  | 'delivered'
  | 'shipped'
  | 'active'
  | 'cancelled';

/**
 * Represents the supported order types
 */
export type OrderType = 'digital' | 'physical' | 'subscription';

/**
 * Base order interface with common properties
 */
export interface Order {
  readonly id: string;
  readonly type: OrderType;
  status: OrderStatus;
}

/**
 * Digital order with download-specific properties
 */
export interface DigitalOrder extends Order {
  readonly type: 'digital';
  readonly downloadUrl?: string;
}

/**
 * Physical order with shipping-specific properties
 */
export interface PhysicalOrder extends Order {
  readonly type: 'physical';
  readonly shippingAddress?: string;
}

/**
 * Subscription order with subscription-specific properties
 */
export interface SubscriptionOrder extends Order {
  readonly type: 'subscription';
  readonly subscriptionPlan?: string;
}

/**
 * Union type for all order types
 */
export type AnyOrder = DigitalOrder | PhysicalOrder | SubscriptionOrder;

/**
 * Result of processing an order
 */
export interface ProcessingResult {
  readonly success: boolean;
  readonly order: AnyOrder;
  readonly message: string;
}

/**
 * Logger interface for dependency injection
 */
export interface Logger {
  log(message: string): void;
}

/**
 * Strategy interface for processing orders (Open/Closed Principle)
 */
export interface OrderProcessingStrategy {
  /**
   * Check if this strategy can handle the given order type
   */
  canHandle(orderType: OrderType): boolean;

  /**
   * Process the order and return the result
   */
  process(order: AnyOrder, logger: Logger): ProcessingResult;
}

// ============================================================================
// Strategy Implementations (Single Responsibility Principle)
// ============================================================================

/**
 * Strategy for processing digital orders
 */
export class DigitalOrderStrategy implements OrderProcessingStrategy {
  canHandle(orderType: OrderType): boolean {
    return orderType === 'digital';
  }

  process(order: AnyOrder, logger: Logger): ProcessingResult {
    logger.log('Sending email with download link');
    const processedOrder: DigitalOrder = {
      ...(order as DigitalOrder),
      status: 'delivered',
    };
    return {
      success: true,
      order: processedOrder,
      message: 'Digital order delivered via email',
    };
  }
}

/**
 * Strategy for processing physical orders
 */
export class PhysicalOrderStrategy implements OrderProcessingStrategy {
  canHandle(orderType: OrderType): boolean {
    return orderType === 'physical';
  }

  process(order: AnyOrder, logger: Logger): ProcessingResult {
    logger.log('Creating shipping label');
    const processedOrder: PhysicalOrder = {
      ...(order as PhysicalOrder),
      status: 'shipped',
    };
    return {
      success: true,
      order: processedOrder,
      message: 'Physical order shipped',
    };
  }
}

/**
 * Strategy for processing subscription orders
 */
export class SubscriptionOrderStrategy implements OrderProcessingStrategy {
  canHandle(orderType: OrderType): boolean {
    return orderType === 'subscription';
  }

  process(order: AnyOrder, logger: Logger): ProcessingResult {
    logger.log('Activating subscription');
    const processedOrder: SubscriptionOrder = {
      ...(order as SubscriptionOrder),
      status: 'active',
    };
    return {
      success: true,
      order: processedOrder,
      message: 'Subscription activated',
    };
  }
}

// ============================================================================
// Default Logger Implementation
// ============================================================================

/**
 * Console-based logger implementation
 */
export class ConsoleLogger implements Logger {
  log(message: string): void {
    console.log(message);
  }
}

// ============================================================================
// Order Processor (Dependency Inversion Principle)
// ============================================================================

/**
 * Main order processor that uses strategies to handle different order types
 */
export class OrderProcessor {
  private readonly strategies: OrderProcessingStrategy[];
  private readonly logger: Logger;

  constructor(strategies: OrderProcessingStrategy[], logger: Logger) {
    this.strategies = strategies;
    this.logger = logger;
  }

  /**
   * Process an order using the appropriate strategy
   */
  processOrder(order: AnyOrder): ProcessingResult {
    const strategy = this.strategies.find((s) => s.canHandle(order.type));

    if (!strategy) {
      return {
        success: false,
        order,
        message: `No strategy found for order type: ${order.type}`,
      };
    }

    const result = strategy.process(order, this.logger);
    this.logger.log(`Order processed: ${order.id}`);

    return result;
  }
}

// ============================================================================
// Factory for Easy Setup
// ============================================================================

/**
 * Factory function to create a fully configured OrderProcessor
 */
export function createOrderProcessor(logger?: Logger): OrderProcessor {
  const strategies: OrderProcessingStrategy[] = [
    new DigitalOrderStrategy(),
    new PhysicalOrderStrategy(),
    new SubscriptionOrderStrategy(),
  ];

  return new OrderProcessor(strategies, logger ?? new ConsoleLogger());
}

// ============================================================================
// Usage Example
// ============================================================================

/**
 * Example usage demonstrating the refactored code
 */
export function exampleUsage(): void {
  const processor = createOrderProcessor();

  const digitalOrder: DigitalOrder = {
    id: 'order-001',
    type: 'digital',
    status: 'pending',
    downloadUrl: 'https://example.com/download/abc',
  };

  const physicalOrder: PhysicalOrder = {
    id: 'order-002',
    type: 'physical',
    status: 'pending',
    shippingAddress: '123 Main St, City, Country',
  };

  const subscriptionOrder: SubscriptionOrder = {
    id: 'order-003',
    type: 'subscription',
    status: 'pending',
    subscriptionPlan: 'premium-monthly',
  };

  console.log('Processing digital order:');
  const digitalResult = processor.processOrder(digitalOrder);
  console.log('Result:', digitalResult);

  console.log('\nProcessing physical order:');
  const physicalResult = processor.processOrder(physicalOrder);
  console.log('Result:', physicalResult);

  console.log('\nProcessing subscription order:');
  const subscriptionResult = processor.processOrder(subscriptionOrder);
  console.log('Result:', subscriptionResult);
}
