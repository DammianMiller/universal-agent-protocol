/**
 * Order Processing System - SOLID Principles Implementation
 *
 * This module demonstrates a refactored order processing system using:
 * - Single Responsibility Principle: Each strategy handles one order type
 * - Open/Closed Principle: New order types can be added without modifying existing code
 * - Liskov Substitution Principle: All strategies can be used interchangeably
 * - Interface Segregation Principle: Focused interfaces for specific needs
 * - Dependency Inversion Principle: Depends on abstractions (interfaces) not concretions
 */

import { z } from 'zod';

/**
 * Order type enum
 */
export enum OrderType {
  DIGITAL = 'digital',
  PHYSICAL = 'physical',
  SUBSCRIPTION = 'subscription',
}

/**
 * Order status enum
 */
export enum OrderStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  SHIPPED = 'shipped',
  ACTIVE = 'active',
}

/**
 * Order interface
 */
export interface Order {
  id: string;
  type: OrderType;
  status: OrderStatus;
  customerId: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Order processing result interface
 */
export interface ProcessingResult {
  success: boolean;
  order: Order;
  message: string;
}

/**
 * Order validation schema using Zod
 */
export const OrderSchema = z.object({
  id: z.string().min(1, 'Order ID is required'),
  type: z.nativeEnum(OrderType),
  status: z.nativeEnum(OrderStatus).default(OrderStatus.PENDING),
  customerId: z.string().min(1, 'Customer ID is required'),
  items: z.array(
    z.object({
      productId: z.string().min(1, 'Product ID is required'),
      quantity: z.number().int().positive('Quantity must be positive'),
      price: z.number().positive('Price must be positive'),
    })
  ).min(1, 'At least one item is required'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * OrderProcessor strategy interface
 * All order processors must implement this interface
 */
export interface OrderProcessor {
  /**
   * Process an order according to its type
   * @param order - The order to process
   * @returns Processing result with updated order status
   * @throws {Error} If processing fails
   */
  process(order: Order): Promise<ProcessingResult>;

  /**
   * Validate that the order can be processed
   * @param order - The order to validate
   * @returns true if valid, false otherwise
   */
  validate(order: Order): boolean;
}

/**
 * Digital order processor strategy
 * Handles delivery of digital products via email
 */
export class DigitalOrderProcessor implements OrderProcessor {
  /**
   * Process a digital order
   * @param order - The digital order to process
   * @returns Processing result with delivered status
   * @throws {Error} If email delivery fails
   */
  async process(order: Order): Promise<ProcessingResult> {
    try {
      // Send email with download link
      await this.sendDownloadLinkEmail(order);

      const processedOrder: Order = {
        ...order,
        status: OrderStatus.DELIVERED,
        updatedAt: new Date(),
      };

      console.log(`Digital order ${order.id} delivered successfully`);

      return {
        success: true,
        order: processedOrder,
        message: `Digital order ${order.id} has been delivered via email`,
      };
    } catch (error) {
      console.error(`Failed to process digital order ${order.id}:`, error);
      throw new Error(`Failed to process digital order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate digital order requirements
   * @param order - The order to validate
   * @returns true if valid for digital processing
   */
  validate(order: Order): boolean {
    return order.type === OrderType.DIGITAL && order.status === OrderStatus.PENDING;
  }

  /**
   * Send download link email to customer
   * @param order - The order containing customer information
   * @throws {Error} If email cannot be sent
   */
  private async sendDownloadLinkEmail(order: Order): Promise<void> {
    // Simulate email sending
    console.log(`Sending email with download link for order ${order.id} to customer ${order.customerId}`);
    // In production: await emailService.sendDownloadLink(order.customerId, order.items);
  }
}

/**
 * Physical order processor strategy
 * Handles shipping of physical products
 */
export class PhysicalOrderProcessor implements OrderProcessor {
  /**
   * Process a physical order
   * @param order - The physical order to process
   * @returns Processing result with shipped status
   * @throws {Error} If shipping label creation fails
   */
  async process(order: Order): Promise<ProcessingResult> {
    try {
      // Create shipping label
      await this.createShippingLabel(order);

      const processedOrder: Order = {
        ...order,
        status: OrderStatus.SHIPPED,
        updatedAt: new Date(),
      };

      console.log(`Physical order ${order.id} shipped successfully`);

      return {
        success: true,
        order: processedOrder,
        message: `Physical order ${order.id} has been shipped`,
      };
    } catch (error) {
      console.error(`Failed to process physical order ${order.id}:`, error);
      throw new Error(`Failed to process physical order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate physical order requirements
   * @param order - The order to validate
   * @returns true if valid for physical processing
   */
  validate(order: Order): boolean {
    return order.type === OrderType.PHYSICAL && order.status === OrderStatus.PENDING;
  }

  /**
   * Create shipping label for the order
   * @param order - The order to create label for
   * @throws {Error} If shipping label cannot be created
   */
  private async createShippingLabel(_order: Order): Promise<void> {
    // Intentionally unused in this stub implementation
    console.log('Creating shipping label');
    // In production: await shippingService.createLabel(order);
  }
}

/**
 * Subscription order processor strategy
 * Handles activation of subscription services
 */
export class SubscriptionOrderProcessor implements OrderProcessor {
  /**
   * Process a subscription order
   * @param order - The subscription order to process
   * @returns Processing result with active status
   * @throws {Error} If subscription activation fails
   */
  async process(order: Order): Promise<ProcessingResult> {
    try {
      // Activate subscription
      await this.activateSubscription(order);

      const processedOrder: Order = {
        ...order,
        status: OrderStatus.ACTIVE,
        updatedAt: new Date(),
      };

      console.log(`Subscription order ${order.id} activated successfully`);

      return {
        success: true,
        order: processedOrder,
        message: `Subscription order ${order.id} has been activated`,
      };
    } catch (error) {
      console.error(`Failed to process subscription order ${order.id}:`, error);
      throw new Error(`Failed to process subscription order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate subscription order requirements
   * @param order - The order to validate
   * @returns true if valid for subscription processing
   */
  validate(order: Order): boolean {
    return order.type === OrderType.SUBSCRIPTION && order.status === OrderStatus.PENDING;
  }

  /**
   * Activate subscription service
   * @param order - The order containing subscription details
   * @throws {Error} If subscription cannot be activated
   */
  private async activateSubscription(_order: Order): Promise<void> {
    // Intentionally unused in this stub implementation
    console.log('Activating subscription');
    // In production: await subscriptionService.activate(order.customerId, order.items);
  }
}

/**
 * OrderProcessor factory
 * Responsible for selecting the appropriate processor based on order type
 * Follows Factory pattern for dependency injection
 */
export class OrderProcessorFactory {
  private readonly processors: Map<OrderType, OrderProcessor>;

  constructor() {
    // Register all available processors
    this.processors = newMap<OrderType, OrderProcessor>([
      [OrderType.DIGITAL, new DigitalOrderProcessor()],
      [OrderType.PHYSICAL, new PhysicalOrderProcessor()],
      [OrderType.SUBSCRIPTION, new SubscriptionOrderProcessor()],
    ]);
  }

  /**
   * Get the appropriate processor for the given order type
   * @param orderType - The type of order
   * @returns The appropriate order processor
   * @throws {Error} If no processor is found for the order type
   */
  getProcessor(orderType: OrderType): OrderProcessor {
    const processor = this.processors.get(orderType);
    if (!processor) {
      throw new Error(`No processor found for order type: ${orderType}`);
    }
    return processor;
  }

  /**
   * Register a new processor for a specific order type
   * @param orderType - The order type to handle
   * @param processor - The processor implementation
   */
  registerProcessor(orderType: OrderType, processor: OrderProcessor): void {
    this.processors.set(orderType, processor);
  }

  /**
   * Check if a processor is registered for the given order type
   * @param orderType - The order type to check
   * @returns true if a processor exists
   */
  hasProcessor(orderType: OrderType): boolean {
    return this.processors.has(orderType);
  }
}

/**
 * Helper function to create a typed Map
 * @param entries - Initial entries for the Map
 * @returns A new Map with the specified entries
 */
function newMap<K, V>(entries: Array<[K, V]>): Map<K, V> {
  return new Map(entries);
}

/**
 * OrderProcessingService
 * Main service that coordinates order processing using the appropriate strategy
 */
export class OrderProcessingService {
  private readonly processorFactory: OrderProcessorFactory;

  constructor(processorFactory?: OrderProcessorFactory) {
    this.processorFactory = processorFactory || new OrderProcessorFactory();
  }

  /**
   * Process an order using the appropriate strategy
   * @param orderInput - The order data to process (may be unvalidated)
   * @returns Processing result with updated order
   * @throws {Error} If validation fails or processing encounters an error
   */
  async processOrder(orderInput: unknown): Promise<ProcessingResult> {
    try {
      // Validate input using Zod schema
      const order = OrderSchema.parse(orderInput) as Order;

      console.log(`Processing order ${order.id} of type ${order.type}`);

      // Get the appropriate processor
      const processor = this.processorFactory.getProcessor(order.type);

      // Validate that the order can be processed
      if (!processor.validate(order)) {
        throw new Error(
          `Order ${order.id} with status ${order.status} cannot be processed`
        );
      }

      // Process the order using the selected strategy
      const result = await processor.process(order);

      console.log(result.message);
      return result;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Validation error:', error.errors);
        throw new Error(`Order validation failed: ${error.errors.map(e => e.message).join(', ')}`);
      }
      console.error('Order processing error:', error);
      throw error;
    }
  }
}

/**
 * Example usage demonstrating the refactored code
 */
export async function exampleUsage(): Promise<void> {
  // Initialize the service
  const orderService = new OrderProcessingService();

  // Example 1: Digital order
  const digitalOrder = {
    id: 'ORD-001',
    type: OrderType.DIGITAL,
    status: OrderStatus.PENDING,
    customerId: 'CUST-123',
    items: [
      {
        productId: 'PROD-DIG-001',
        quantity: 1,
        price: 29.99,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const result1 = await orderService.processOrder(digitalOrder);
    console.log('Result:', result1);
  } catch (error) {
    console.error('Error:', error);
  }

  // Example 2: Physical order
  const physicalOrder = {
    id: 'ORD-002',
    type: OrderType.PHYSICAL,
    status: OrderStatus.PENDING,
    customerId: 'CUST-456',
    items: [
      {
        productId: 'PROD-PHY-001',
        quantity: 2,
        price: 49.99,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const result2 = await orderService.processOrder(physicalOrder);
    console.log('Result:', result2);
  } catch (error) {
    console.error('Error:', error);
  }

  // Example 3: Subscription order
  const subscriptionOrder = {
    id: 'ORD-003',
    type: OrderType.SUBSCRIPTION,
    status: OrderStatus.PENDING,
    customerId: 'CUST-789',
    items: [
      {
        productId: 'PROD-SUB-001',
        quantity: 1,
        price: 19.99,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const result3 = await orderService.processOrder(subscriptionOrder);
    console.log('Result:', result3);
  } catch (error) {
    console.error('Error:', error);
  }
}
