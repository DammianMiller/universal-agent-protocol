// ============================================
// Strategy Pattern: Order Processing Refactor
// ============================================

// Strategy interface
interface OrderProcessingStrategy {
  process(order: Order): Order;
}

// Order interface for type safety
interface Order {
  type: string;
  status?: string;  // Status is optional, computed during processing
  [key: string]: any; // Allow additional properties
}

// ===== Concrete Strategy Implementations =====

class DigitalOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    // Assume: order is a valid digital order with required fields
    // Condition: order.type should be 'digital'
    // Edge case: Order might be null/undefined - we return a new object to maintain immutability
    return { ...order, status: 'delivered' };
  }
}

class PhysicalOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    // Assume: order is a valid physical order with shipping address
    // Condition: order.type should be 'physical'
    return { ...order, status: 'shipped' };
  }
}

class SubscriptionOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    // Assume: order is a valid subscription order with billing info
    // Condition: order.type should be 'subscription'
    return { ...order, status: 'active' };
  }
}

// Default/fallback strategy for unknown order types
class DefaultOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    // Assume: order is valid but type is unknown
    // Condition: Handles any unrecognized order type gracefully
    return { ...order, status: 'pending' };
  }
}

// ===== Strategy Factory =====

class OrderProcessingStrategyFactory {
  private strategies: Map<string, OrderProcessingStrategy> = new Map();

  constructor() {
    // Register default strategies
    this.registerStrategy('digital', new DigitalOrderStrategy());
    this.registerStrategy('physical', new PhysicalOrderStrategy());
    this.registerStrategy('subscription', new SubscriptionOrderStrategy());
  }

  registerStrategy(type: string, strategy: OrderProcessingStrategy): void {
    // Assume: type is a non-empty string, strategy is valid
    // Condition: Adds strategy to registry, overwriting if type exists
    this.strategies.set(type, strategy);
  }

  getStrategy(type: string): OrderProcessingStrategy {
    // Assume: type is a string
    // Condition: Returns strategy if found, else returns default
    // Edge case: type might be undefined - handled by returning default
    return this.strategies.get(type) || new DefaultOrderStrategy();
  }

  hasStrategy(type: string): boolean {
    return this.strategies.has(type);
  }
}

// ===== Context (Order Processor) =====

class OrderProcessor {
  private factory: OrderProcessingStrategyFactory;

  constructor(factory?: OrderProcessingStrategyFactory) {
    // Assume: factory is provided or create default
    // Condition: Uses dependency injection for testability
    this.factory = factory || new OrderProcessingStrategyFactory();
  }

  processOrder(order: Order): Order {
    // Assume: order is a valid object with at least a 'type' property
    // Condition: Processes order using appropriate strategy
    // Edge case: order is undefined/null - we handle defensively
    if (!order || typeof order !== 'object') {
      throw new Error('Invalid order: must be an object');
    }

    const strategy = this.factory.getStrategy(order.type);
    return strategy.process(order);
  }
}

// ============================================
// Usage Examples
// ============================================

// Create processor instance
const processor = new OrderProcessor();

// Process different order types
const digitalOrder = processor.processOrder({
  type: 'digital',
  id: 'DIG-001',
  items: ['software license']
});

const physicalOrder = processor.processOrder({
  type: 'physical',
  id: 'PHY-001',
  items: ['laptop'],
  shippingAddress: '123 Main St'
});

const subscriptionOrder = processor.processOrder({
  type: 'subscription',
  id: 'SUB-001',
  items: ['monthly service'],
  billingCycle: 'monthly'
});

// Processing unknown order type (falls back to DefaultOrderStrategy)
const unknownOrder = processor.processOrder({
  type: 'unknown',
  id: 'UNK-001',
  items: ['something']
});

console.log('Digital Order:', digitalOrder);   // { type: 'digital', status: 'delivered', ... }
console.log('Physical Order:', physicalOrder);  // { type: 'physical', status: 'shipped', ... }
console.log('Subscription Order:', subscriptionOrder); // { type: 'subscription', status: 'active', ... }
console.log('Unknown Order:', unknownOrder);    // { type: 'unknown', status: 'pending', ... }

// ============================================
// Extensibility Example: Adding a New Order Type
// ============================================

// Define a new strategy for a new order type
class ServiceOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    return { ...order, status: 'scheduled' };
  }
}

// Register the new strategy with the factory
const customFactory = new OrderProcessingStrategyFactory();
customFactory.registerStrategy('service', new ServiceOrderStrategy());

// Create processor with custom factory
const customProcessor = new OrderProcessor(customFactory);

// Now we can process service orders
const serviceOrder = customProcessor.processOrder({
  type: 'service',
  id: 'SRV-001',
  items: ['consultation']
});

console.log('Service Order:', serviceOrder);  // { type: 'service', status: 'scheduled', ... }

// ============================================
// Benefits of Strategy Pattern:
// ============================================
/*
1. Open/Closed Principle: Easy to add new order types without modifying existing code
2. Single Responsibility: Each strategy handles one specific order type
3. Testability: Each strategy can be tested independently
4. Flexibility: Strategies can be swapped at runtime
5. Type Safety: TypeScript interfaces ensure contract compliance
6. Immutability: Returns new objects instead of mutating input
7. Extensibility: New strategies can be registered via factory
8. Encapsulation: Each strategy hides its implementation details
*/
