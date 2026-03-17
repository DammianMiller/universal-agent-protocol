/**
 * Order Processing System - SOLID Principles Refactoring
 *
 * This module demonstrates a refactored order processing system using SOLID principles
 * and the Strategy Design Pattern.
 *
 * SOLID Principles Implemented:
 * - Single Responsibility: Each class has one clear purpose
 * - Open/Closed: New order types can be added without modifying existing code
 * - Liskov Substitution: All strategies can be used interchangeably
 * - Interface Segregation: Focused interfaces for specific needs
 * - Dependency Inversion: Depends on abstractions (interfaces) not concretions
 */

/**
 * Order type enumeration for type safety
 */
export enum OrderType {
  DIGITAL = 'digital',
  PHYSICAL = 'physical',
  SUBSCRIPTION = 'subscription',
}

/**
 * Order status enumeration for tracking order lifecycle
 */
export enum OrderStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  SHIPPED = 'shipped',
  ACTIVE = 'active',
  FAILED = 'failed',
}

/**
 * Order interface - defines the contract for order data
 */
export interface Order {
  id: string;
  type: OrderType;
  status: OrderStatus;
  customerEmail: string;
  items: OrderItem[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * OrderItem interface for items within an order
 */
export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
}

/**
 * Result interface for order processing operations
 */
export interface ProcessingResult {
  success: boolean;
  order: Order;
  message: string;
  timestamp: Date;
}

/**
 * OrderProcessor interface - Strategy Pattern
 *
 * This interface defines the contract for order processing strategies.
 * Each concrete implementation handles a specific order type.
 */
export interface OrderProcessor {
  /**
   * Process the order according to its type
   * @param order - The order to process
   * @returns ProcessingResult with updated order and processing details
   * @throws AppError if processing fails
   */
  process(order: Order): Promise<ProcessingResult>;

  /**
   * Check if this processor can handle the given order type
   * @param type - The order type to check
   * @returns true if this processor handles the type
   */
  canHandle(type: OrderType): boolean;
}

/**
 * Custom error class for application-specific errors
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * DigitalOrderProcessor - handles digital product orders
 *
 * Single Responsibility: Send download links and mark as delivered
 */
export class DigitalOrderProcessor implements OrderProcessor {
  canHandle(type: OrderType): boolean {
    return type === OrderType.DIGITAL;
  }

  async process(order: Order): Promise<ProcessingResult> {
    // Validate input
    if (!order.customerEmail) {
      throw new AppError(
        'Customer email is required for digital orders',
        'MISSING_EMAIL',
        400
      );
    }

    try {
      // Send email with download link
      await this.sendDownloadLink(order.customerEmail, order.id);

      const processedOrder: Order = {
        ...order,
        status: OrderStatus.DELIVERED,
        updatedAt: new Date(),
      };

      console.log(`Order processed: ${processedOrder.id}`);

      return {
        success: true,
        order: processedOrder,
        message: 'Digital order processed successfully',
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        order,
        message: `Failed to process digital order: ${errorMessage}`,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Sends download link email to customer
   * @private
   */
  private async sendDownloadLink(email: string, orderId: string): Promise<void> {
    console.log(`Sending email with download link for order ${orderId}`);
    // In production: await emailService.sendDownloadLink(email, orderId);
  }
}

/**
 * PhysicalOrderProcessor - handles physical product orders
 *
 * Single Responsibility: Create shipping labels and mark as shipped
 */
export class PhysicalOrderProcessor implements OrderProcessor {
  canHandle(type: OrderType): boolean {
    return type === OrderType.PHYSICAL;
  }

  async process(order: Order): Promise<ProcessingResult> {
    // Validate input
    if (!order.items || order.items.length === 0) {
      throw new AppError(
        'Physical order must contain at least one item',
        'EMPTY_ORDER',
        400
      );
    }

    try {
      // Create shipping label
      await this.createShippingLabel(order);

      const processedOrder: Order = {
        ...order,
        status: OrderStatus.SHIPPED,
        updatedAt: new Date(),
      };

      console.log(`Order processed: ${processedOrder.id}`);

      return {
        success: true,
        order: processedOrder,
        message: 'Physical order processed successfully',
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const failedOrder: Order = {
        ...order,
        status: OrderStatus.FAILED,
        updatedAt: new Date(),
      };

      return {
        success: false,
        order: failedOrder,
        message: `Failed to process physical order: ${errorMessage}`,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Creates shipping label for the order
   * @private
   */
  private async createShippingLabel(order: Order): Promise<void> {
    console.log(`Creating shipping label for order ${order.id}`);
    // In production: await shippingService.createLabel(order);
  }
}

/**
 * SubscriptionOrderProcessor - handles subscription orders
 *
 * Single Responsibility: Activate subscriptions and manage recurring billing
 */
export class SubscriptionOrderProcessor implements OrderProcessor {
  canHandle(type: OrderType): boolean {
    return type === OrderType.SUBSCRIPTION;
  }

  async process(order: Order): Promise<ProcessingResult> {
    // Validate input
    if (!order.customerEmail) {
      throw new AppError(
        'Customer email is required for subscriptions',
        'MISSING_EMAIL',
        400
      );
    }

    try {
      // Activate subscription
      await this.activateSubscription(order);

      const processedOrder: Order = {
        ...order,
        status: OrderStatus.ACTIVE,
        updatedAt: new Date(),
      };

      console.log(`Order processed: ${processedOrder.id}`);

      return {
        success: true,
        order: processedOrder,
        message: 'Subscription order processed successfully',
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const failedOrder: Order = {
        ...order,
        status: OrderStatus.FAILED,
        updatedAt: new Date(),
      };

      return {
        success: false,
        order: failedOrder,
        message: `Failed to process subscription order: ${errorMessage}`,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Activates subscription service
   * @private
   */
  private async activateSubscription(order: Order): Promise<void> {
    console.log(`Activating subscription for order ${order.id}`);
    // In production: await subscriptionService.activate(order);
  }
}

/**
 * OrderProcessorFactory - Creates appropriate processor for order type
 *
 * Single Responsibility: Select the correct strategy based on order type
 * Follows Factory pattern for dependency inversion
 */
export class OrderProcessorFactory {
  private processors: Map<OrderType, OrderProcessor> = new Map();

  constructor() {
    // Register available processors
    this.registerProcessor(new DigitalOrderProcessor());
    this.registerProcessor(new PhysicalOrderProcessor());
    this.registerProcessor(new SubscriptionOrderProcessor());
  }

  /**
   * Register a processor for a specific order type
   * @param processor - The processor to register
   */
  private registerProcessor(processor: OrderProcessor): void {
    for (const type of Object.values(OrderType)) {
      if (processor.canHandle(type)) {
        this.processors.set(type, processor);
      }
    }
  }

  /**
   * Get the appropriate processor for the given order type
   * @param type - The order type
   * @returns OrderProcessor instance
   * @throws AppError if no processor found for the type
   */
  getProcessor(type: OrderType): OrderProcessor {
    const processor = this.processors.get(type);

    if (!processor) {
      throw new AppError(
        `No processor found for order type: ${type}`,
        'UNSUPPORTED_ORDER_TYPE',
        400
      );
    }

    return processor;
  }

  /**
   * Check if a processor exists for the given order type
   * @param type - The order type to check
   * @returns true if a processor is available
   */
  hasProcessor(type: OrderType): boolean {
    return this.processors.has(type);
  }
}

/**
 * OrderProcessorContext - Orchestrates order processing
 *
 * Single Responsibility: Coordinate processing using the factory pattern
 * Dependency Inversion: Depends on OrderProcessorFactory interface
 */
export class OrderProcessorContext {
  private readonly factory: OrderProcessorFactory;

  constructor(factory?: OrderProcessorFactory) {
    this.factory = factory || new OrderProcessorFactory();
  }

  /**
   * Process an order using the appropriate strategy
   * @param order - The order to process
   * @returns ProcessingResult with updated order and processing details
   */
  async processOrder(order: Order): Promise<ProcessingResult> {
    // Validate order structure
    if (!order.id || !order.type) {
      throw new AppError(
        'Order must have valid id and type',
        'INVALID_ORDER',
        400
      );
    }

    // Check if processor exists
    if (!this.factory.hasProcessor(order.type)) {
      throw new AppError(
        `Unsupported order type: ${order.type}`,
        'UNSUPPORTED_ORDER_TYPE',
        400
      );
    }

    // Get appropriate processor and execute
    const processor = this.factory.getProcessor(order.type);
    const result = await processor.process(order);

    console.log(result.message);
    return result;
  }
}

/**
 * Main entry point function for backwards compatibility
 * Maintains the same signature as the original function
 */
export async function processOrder(order: Order): Promise<Order> {
  const context = new OrderProcessorContext();
  const result = await context.processOrder(order);

  if (!result.success) {
    throw new AppError(result.message, 'PROCESSING_FAILED', 500);
  }

  return result.order;
}

/**
 * Example usage demonstrating the refactored code
 */
export async function demonstrateUsage(): Promise<void> {
  const context = new OrderProcessorContext();

  // Example 1: Digital order
  const digitalOrder: Order = {
    id: 'order-001',
    type: OrderType.DIGITAL,
    status: OrderStatus.PENDING,
    customerEmail: 'customer@example.com',
    items: [{ id: 'item-1', name: 'E-book', quantity: 1, price: 9.99 }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  console.log('\n--- Processing Digital Order ---');
  const digitalResult = await context.processOrder(digitalOrder);
  console.log('Digital Order Result:', digitalResult);

  // Example 2: Physical order
  const physicalOrder: Order = {
    id: 'order-002',
    type: OrderType.PHYSICAL,
    status: OrderStatus.PENDING,
    customerEmail: 'customer@example.com',
    items: [{ id: 'item-2', name: 'T-shirt', quantity: 2, price: 29.99 }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  console.log('\n--- Processing Physical Order ---');
  const physicalResult = await context.processOrder(physicalOrder);
  console.log('Physical Order Result:', physicalResult);

  // Example 3: Subscription order
  const subscriptionOrder: Order = {
    id: 'order-003',
    type: OrderType.SUBSCRIPTION,
    status: OrderStatus.PENDING,
    customerEmail: 'customer@example.com',
    items: [{ id: 'item-3', name: 'Premium Plan', quantity: 1, price: 19.99 }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  console.log('\n--- Processing Subscription Order ---');
  const subscriptionResult = await context.processOrder(subscriptionOrder);
  console.log('Subscription Order Result:', subscriptionResult);
}

// If run directly, demonstrate usage
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  demonstrateUsage().catch(console.error);
}
