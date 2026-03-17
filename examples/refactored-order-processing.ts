// ============================================
// Concise Strategy Pattern Implementation
// ============================================

// Strategy interface
export interface OrderProcessingStrategy {
  process(order: Order): Order;
}

// Order interface for type safety
export interface Order {
  type: string;
  status?: string;
  [key: string]: any;
}

// ===== Concrete Strategies =====

export class DigitalOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    return { ...order, status: 'delivered' };
  }
}

export class PhysicalOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    return { ...order, status: 'shipped' };
  }
}

export class SubscriptionOrderStrategy implements OrderProcessingStrategy {
  process(order: Order): Order {
    return { ...order, status: 'active' };
  }
}

// ===== Context with Strategy Selection =====

export class OrderProcessor {
  private strategies: Record<string, OrderProcessingStrategy>;

  constructor() {
    this.strategies = {
      digital: new DigitalOrderStrategy(),
      physical: new PhysicalOrderStrategy(),
      subscription: new SubscriptionOrderStrategy(),
    };
  }

  processOrder(order: Order): Order {
    const strategy = this.strategies[order.type];
    if (!strategy) {
      // Handle unknown order types gracefully
      return { ...order, status: 'pending' };
    }
    return strategy.process(order);
  }

  addStrategy(type: string, strategy: OrderProcessingStrategy): void {
    this.strategies[type] = strategy;
  }
}

// ===== Usage =====

const processor = new OrderProcessor();

// Example 1: Digital order
const order1 = processor.processOrder({ type: 'digital', id: 1 });
console.log(order1); // { type: 'digital', id: 1, status: 'delivered' }

// Example 2: Physical order
const order2 = processor.processOrder({ type: 'physical', id: 2 });
console.log(order2); // { type: 'physical', id: 2, status: 'shipped' }

// Example 3: Subscription order
const order3 = processor.processOrder({ type: 'subscription', id: 3 });
console.log(order3); // { type: 'subscription', id: 3, status: 'active' }

// Example 4: Unknown order type
const order4 = processor.processOrder({ type: 'gift_card', id: 4 });
console.log(order4); // { type: 'gift_card', id: 4, status: 'pending' }

// ============================================
// Comparison with Original Code
// ============================================

// Original code:
// function processOrder(order: any) {
//   if (order.type === 'digital') {
//     order.status = 'delivered';
//   } else if (order.type === 'physical') {
//     order.status = 'shipped';
//   } else if (order.type === 'subscription') {
//     order.status = 'active';
//   }
//   return order;
// }

// Strategy Pattern Benefits:
// 1. Better type safety with TypeScript interfaces
// 2. OCP: Add new order types without modifying existing code
// 3. Each strategy is independently testable
// 4. No mutation of input (returns new objects)
// 5. Easy to extend with new strategies
// 6. Handles unknown types gracefully
