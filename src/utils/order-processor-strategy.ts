/**
 * Strategy Pattern Implementation for Order Processing
 * 
 * The Strategy pattern allows defining a family of algorithms, encapsulating each one,
 * and making them interchangeable. This refactoring replaces conditional logic with
 * polymorphic behavior.
 */

// Order type definition for type safety
type OrderType = 'digital' | 'physical' | 'subscription';

// Order interface
interface Order {
  type: OrderType;
  status?: string;
  [key: string]: any;
}

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

/**
 * OrderProcessingStrategy defines the contract for all order processing strategies.
 * Each concrete strategy implements the process method according to its specific logic.
 */
interface OrderProcessingStrategy {
  process(order: Order): Order;
}

// ============================================================================
// CONCRETE STRATEGIES
// ============================================================================

/**
 * DigitalOrderStrategy handles digital product orders.
 * Digital orders are immediately delivered upon processing.
 */
class DigitalOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    return {
      ...order,
      status: 'delivered',
      deliveryMethod: 'digital',
      deliveryTimestamp: new Date().toISOString()
    };
  }
}

/**
 * PhysicalOrderStrategy handles physical product orders.
 * Physical orders require shipping and physical delivery.
 */
class PhysicalOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    return {
      ...order,
      status: 'shipped',
      deliveryMethod: 'physical',
      shippingDate: new Date().toISOString(),
      estimatedDelivery: this.estimateDelivery()
    };
  }

  private estimateDelivery(): string {
    const date = new Date();
    date.setDate(date.getDate() + 5); // 5 business days
    return date.toISOString();
  }
}

/**
 * SubscriptionOrderStrategy handles subscription orders.
 * Subscriptions activate immediately and require ongoing billing.
 */
class SubscriptionOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    return {
      ...order,
      status: 'active',
      subscriptionType: 'recurring',
      billingCycle: 'monthly',
      activationDate: new Date().toISOString(),
      nextBilling: this.calculateNextBilling()
    };
  }

  private calculateNextBilling(): string {
    const date = new Date();
    date.setMonth(date.getMonth() + 1);
    return date.toISOString();
  }
}

// ============================================================================
// CONTEXT (ORDER PROCESSOR)
// ============================================================================

/**
 * OrderProcessor acts as the context that uses strategies to process orders.
 * It maintains a strategy registry and delegates order processing to the appropriate strategy.
 */
class OrderProcessor {
  private strategies: Map<OrderType, OrderProcessingStrategy>;

  constructor() {
    // Initialize the strategy registry
    this.strategies = new Map([
      ['digital', new DigitalOrderStrategy()],
      ['physical', new PhysicalOrderStrategy()],
      ['subscription', new SubscriptionOrderStrategy()]
    ]);
  }

  /**
   * Process an order using the appropriate strategy based on its type.
   * @param order The order to process
   * @returns The processed order with status and additional metadata
   * @throws Error if no strategy is found for the order type
   */
  processOrder(order: Order): Order {
    const strategy = this.strategies.get(order.type);
    
    if (!strategy) {
      throw new Error(`No processing strategy found for order type: ${order.type}`);
    }

    return strategy.process(order);
  }

  /**
   * Register a custom strategy for a specific order type.
   * This allows extending the processor with new order types at runtime.
   * @param orderType The order type this strategy handles
   * @param strategy The strategy to register
   */
  registerStrategy(orderType: string, strategy: OrderProcessingStrategy): void {
    this.strategies.set(orderType as OrderType, strategy);
  }

  /**
   * Get all registered order types.
   * @returns Array of supported order types
   */
  getSupportedOrderTypes(): OrderType[] {
    return Array.from(this.strategies.keys());
  }
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

/**
 * Example usage demonstrating the Strategy pattern in action.
 */
function demonstrateOrderProcessing() {
  const processor = new OrderProcessor();

  // Example orders
  const digitalOrder: Order = {
    type: 'digital',
    id: 'DIG-001',
    product: 'Premium Software License',
    price: 99.99
  };

  const physicalOrder: Order = {
    type: 'physical',
    id: 'PHY-001',
    product: 'Office Chair',
    price: 249.99,
    shippingAddress: '123 Main St, City, State'
  };

  const subscriptionOrder: Order = {
    type: 'subscription',
    id: 'SUB-001',
    product: 'Cloud Storage Pro',
    price: 19.99
  };

  // Process orders
  console.log('Processing Digital Order:');
  console.log(JSON.stringify(processor.processOrder(digitalOrder), null, 2));
  console.log('\nProcessing Physical Order:');
  console.log(JSON.stringify(processor.processOrder(physicalOrder), null, 2));
  console.log('\nProcessing Subscription Order:');
  console.log(JSON.stringify(processor.processOrder(subscriptionOrder), null, 2));

  // Show supported order types
  console.log('\nSupported Order Types:', processor.getSupportedOrderTypes());
}

// Export for use in other modules
export {
  Order,
  OrderType,
  OrderProcessingStrategy,
  DigitalOrderStrategy,
  PhysicalOrderStrategy,
  SubscriptionOrderStrategy,
  OrderProcessor
};

// Run demo if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  demonstrateOrderProcessing();
}
