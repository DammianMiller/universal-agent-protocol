/**
 * SOLID Principles-Compliant Order Processing System
 *
 * This module demonstrates a refactored order processing system that strictly
 * follows SOLID principles and the project's coding standards.
 *
 * ASSUMPTIONS:
 * - Orders contain a valid 'type' property (string)
 * - Order types are known at runtime or have fallback behavior
 * - Processing is synchronous (no async operations required)
 *
 * EDGE CASES HANDLED:
 * - Invalid/missing order data (throws AppError)
 * - Unknown order types (uses DefaultOrderStrategy)
 * - Null/undefined input (throws AppError)
 * - Invalid type values (falls back to default strategy)
 *
 * EDGE CASES NOT HANDLED:
 * - Concurrent order processing (not thread-safe by default)
 * - Distributed processing across multiple services
 * - Complex validation beyond type checking
 * - Order persistence or database operations
 *
 * @module order-solid-refactor
 */

import { z } from 'zod';

// ============================================
// Error Types
// ============================================

/**
 * Custom error class for order processing failures.
 * Extends the built-in Error class with additional context.
 */
export class OrderProcessingError extends Error {
  /** Error code for programmatic handling */
  readonly code: string;
  /** Additional context about the error */
  readonly context?: Record<string, unknown>;

  /**
   * Creates a new OrderProcessingError instance.
   *
   * @param message - Human-readable error message
   * @param code - Error code for programmatic handling
   * @param context - Optional additional context
   */
  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OrderProcessingError';
    this.code = code;
    this.context = context;

    // Maintains proper stack trace (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OrderProcessingError);
    }
  }
}

// ============================================
// Domain Models & Validation
// ============================================

/**
 * Order status enumeration for type safety.
 */
export enum OrderStatus {
  DELIVERED = 'delivered',
  SHIPPED = 'shipped',
  ACTIVE = 'active',
  SCHEDULED = 'scheduled',
  PENDING = 'pending',
}

/**
 * Minimum valid order interface.
 * All order types must have at least these properties.
 */
export interface BaseOrder {
  type: string;
  id: string;
  [key: string]: unknown;
}

/**
 * Processed order with computed status.
 * @template T - Additional order properties
 */
export interface ProcessedOrder extends BaseOrder {
  status: OrderStatus;
  [key: string]: unknown;
}

/**
 * Zod schema for validating order objects.
 * Ensures order has required 'type' and 'id' properties.
 */
const orderSchema = z.object({
  type: z.string().min(1, 'Order type must be a non-empty string'),
  id: z.string().min(1, 'Order ID must be a non-empty string'),
}).passthrough(); // Allow additional properties

/**
 * Validates and normalizes an order object.
 *
 * @param order - The order to validate
 * @returns The validated order object
 * @throws OrderProcessingError if validation fails
 *
 * @example
 * ```typescript
 * validateOrder({ type: 'digital', id: '123' }); // Success
 * validateOrder({ type: '', id: '123' }); // Throws OrderProcessingError
 * ```
 */
export function validateOrder(order: unknown): BaseOrder {
  const result = orderSchema.safeParse(order);

  if (!result.success) {
    throw new OrderProcessingError(
      'Invalid order data',
      'INVALID_ORDER',
      { errors: result.error.errors, input: order }
    );
  }

  return result.data;
}

// ============================================
// Strategy Pattern (Single Responsibility, Open/Closed)
// ============================================

/**
 * Strategy interface for processing different order types.
 * Each strategy handles one specific order type (Single Responsibility Principle).
 *
 * Implements Strategy Pattern to satisfy:
 * - Open/Closed Principle: New strategies can be added without modifying existing code
 * - Single Responsibility Principle: Each class has one reason to change
 */
export interface OrderProcessingStrategy {
  /**
   * Processes an order and returns the result with updated status.
   *
   * @param order - The order to process (not mutated)
   * @returns Processed order with status
   * @throws OrderProcessingError if processing fails
   */
  process(order: BaseOrder): ProcessedOrder;
}

/**
 * Processes digital orders (e.g., software licenses, downloads).
 *
 * ASSUMPTIONS:
 * - Order type is 'digital'
 * - Order has valid delivery email or download method
 */
export class DigitalOrderStrategy implements OrderProcessingStrategy {
  /**
   * Processes a digital order by setting status to delivered.
   *
   * @param order - The digital order to process
   * @returns Order with status set to 'delivered'
   */
  process(order: BaseOrder): ProcessedOrder {
    // Assume: order.type === 'digital' (enforced by factory)
    // Condition: Digital orders are immediately delivered
    // Edge case: Invalid order data already validated before reaching here

    return {
      ...order,
      status: OrderStatus.DELIVERED,
      processedAt: new Date().toISOString(),
    };
  }
}

/**
 * Processes physical orders (e.g., products requiring shipping).
 *
 * ASSUMPTIONS:
 * - Order type is 'physical'
 * - Order contains shipping information
 */
export class PhysicalOrderStrategy implements OrderProcessingStrategy {
  /**
   * Processes a physical order by setting status to shipped.
   *
   * @param order - The physical order to process
   * @returns Order with status set to 'shipped'
   */
  process(order: BaseOrder): ProcessedOrder {
    // Assume: order.type === 'physical' (enforced by factory)
    // Condition: Physical orders require shipping label generation
    // Edge case: Missing shipping address would need additional validation

    return {
      ...order,
      status: OrderStatus.SHIPPED,
      processedAt: new Date().toISOString(),
    };
  }
}

/**
 * Processes subscription orders (e.g., recurring services).
 *
 * ASSUMPTIONS:
 * - Order type is 'subscription'
 * - Order contains billing information
 */
export class SubscriptionOrderStrategy implements OrderProcessingStrategy {
  /**
   * Processes a subscription order by setting status to active.
   *
   * @param order - The subscription order to process
   * @returns Order with status set to 'active'
   */
  process(order: BaseOrder): ProcessedOrder {
    // Assume: order.type === 'subscription' (enforced by factory)
    // Condition: Subscriptions activate immediately
    // Edge case: Payment processing would occur before activation

    return {
      ...order,
      status: OrderStatus.ACTIVE,
      processedAt: new Date().toISOString(),
    };
  }
}

/**
 * Processes gift card orders.
 *
 * ASSUMPTIONS:
 * - Order type is 'gift_card'
 * - Order contains recipient information
 */
export class GiftCardOrderStrategy implements OrderProcessingStrategy {
  /**
   * Processes a gift card order by setting status to delivered.
   *
   * @param order - The gift card order to process
   * @returns Order with status set to 'delivered' (card generated)
   */
  process(order: BaseOrder): ProcessedOrder {
    // Assume: order.type === 'gift_card' (enforced by factory)
    // Condition: Gift cards are immediately available

    return {
      ...order,
      status: OrderStatus.DELIVERED,
      processedAt: new Date().toISOString(),
    };
  }
}

/**
 * Default strategy for unknown order types.
 * Provides graceful fallback behavior instead of failing.
 *
 * ASSUMPTIONS:
 * - Order type is unknown or unregistered
 * - System should still process the order with a safe default
 */
export class DefaultOrderStrategy implements OrderProcessingStrategy {
  /**
   * Processes an unknown order type by setting status to pending.
   * This allows the order to be reviewed manually later.
   *
   * @param order - The unknown order type to process
   * @returns Order with status set to 'pending'
   */
  process(order: BaseOrder): ProcessedOrder {
    // Assume: order.type is not recognized
    // Condition: Unknown types default to pending for manual review
    // Edge case: Order might be completely invalid (already validated)

    return {
      ...order,
      status: OrderStatus.PENDING,
      processedAt: new Date().toISOString(),
      requiresManualReview: true,
    };
  }
}

// ============================================
// Factory Pattern (Dependency Inversion)
// ============================================

/**
 * Factory for creating and managing order processing strategies.
 * Implements Dependency Inversion Principle by depending on abstractions (interface).
 *
 * BENEFITS:
 * - Central strategy registration
 * - Easy to extend with new strategies
 * - Testable via dependency injection
 * - Type-safe strategy lookup
 */
export class OrderProcessingStrategyFactory {
  private strategies: Map<string, OrderProcessingStrategy> = new Map();

  /**
   * Creates a new factory with default strategies registered.
   */
  constructor() {
    this.registerDefaultStrategies();
  }

  /**
   * Registers all default order processing strategies.
   * This is a template method that can be overridden or extended.
   */
  private registerDefaultStrategies(): void {
    this.registerStrategy('digital', new DigitalOrderStrategy());
    this.registerStrategy('physical', new PhysicalOrderStrategy());
    this.registerStrategy('subscription', new SubscriptionOrderStrategy());
    this.registerStrategy('gift_card', new GiftCardOrderStrategy());
  }

  /**
   * Registers a new strategy for a specific order type.
   *
   * @param type - The order type this strategy handles
   * @param strategy - The strategy instance to register
   * @throws TypeError if type is empty or strategy is invalid
   *
   * @example
   * ```typescript
   * factory.registerStrategy('service', new ServiceOrderStrategy());
   * ```
   */
  registerStrategy(type: string, strategy: OrderProcessingStrategy): void {
    if (!type || typeof type !== 'string') {
      throw new TypeError('Order type must be a non-empty string');
    }

    if (!this.isValidStrategy(strategy)) {
      throw new TypeError('Strategy must implement OrderProcessingStrategy interface');
    }

    this.strategies.set(type, strategy);
  }

  /**
   * Retrieves a strategy for the given order type.
   * Returns DefaultOrderStrategy if type is not registered.
   *
   * @param type - The order type to get a strategy for
   * @returns The appropriate strategy instance
   */
  getStrategy(type: string): OrderProcessingStrategy {
    // Assume: type is a non-empty string
    // Condition: Returns strategy if found, else returns default
    // Edge case: type might be undefined - handled gracefully

    if (!type || typeof type !== 'string') {
      return new DefaultOrderStrategy();
    }

    return this.strategies.get(type) || new DefaultOrderStrategy();
  }

  /**
   * Checks if a strategy is registered for the given order type.
   *
   * @param type - The order type to check
   * @returns true if a strategy is registered, false otherwise
   */
  hasStrategy(type: string): boolean {
    return this.strategies.has(type);
  }

  /**
   * Returns all registered order type keys.
   *
   * @returns Array of registered order types
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Validates that a strategy implements the required interface.
   * Uses duck typing to check for the 'process' method.
   *
   * @param strategy - The strategy to validate
   * @returns true if valid, false otherwise
   */
  private isValidStrategy(strategy: unknown): boolean {
    return (
      strategy !== null &&
      typeof strategy === 'object' &&
      'process' in strategy &&
      typeof (strategy as OrderProcessingStrategy).process === 'function'
    );
  }
}

// ============================================
// Context / Processor (Liskov Substitution, Interface Segregation)
// ============================================

/**
 * Primary context class for processing orders.
 * Implements Liskov Substitution Principle by working with
 * OrderProcessingStrategy interface abstractions.
 *
 * Implements Interface Segregation Principle by having focused, cohesive methods.
 */
export class OrderProcessor {
  private factory: OrderProcessingStrategyFactory;
  private processingLog: Array<{ orderId: string; type: string; status: OrderStatus; timestamp: string }> = [];

  /**
   * Creates a new OrderProcessor instance.
   *
   * @param factory - Optional custom strategy factory (dependency injection)
   * @throws TypeError if factory is invalid
   */
  constructor(factory?: OrderProcessingStrategyFactory) {
    // Assume: factory is a valid OrderProcessingStrategyFactory instance
    // Condition: Uses provided factory or creates default
    // Edge case: Invalid factory - handled by type checking

    if (factory && !(factory instanceof OrderProcessingStrategyFactory)) {
      throw new TypeError('Factory must be an instance of OrderProcessingStrategyFactory');
    }

    this.factory = factory || new OrderProcessingStrategyFactory();
  }

  /**
   * Processes an order using the appropriate strategy.
   *
   * This method follows the Template Method pattern:
   * 1. Validates the order
   * 2. Selects the appropriate strategy
   * 3. Processes the order
   * 4. Logs the processing result
   * 5. Returns the processed order
   *
   * @param order - The order to process
   * @returns The processed order with updated status
   * @throws OrderProcessingError if order is invalid
   * @throws TypeError if order is null/undefined
   *
   * @example
   * ```typescript
   * const processor = new OrderProcessor();
   * const result = processor.processOrder({ type: 'digital', id: '123' });
   * console.log(result.status); // 'delivered'
   * ```
   */
  processOrder(order: unknown): ProcessedOrder {
    // Assume: order is a valid object with 'type' and 'id'
    // Condition: Processes order using appropriate strategy
    // Edge case: order is undefined/null - handled defensively

    // Step 1: Input validation
    if (order === null || order === undefined) {
      throw new TypeError('Order cannot be null or undefined');
    }

    const validatedOrder = validateOrder(order);

    // Step 2: Select strategy
    const strategy = this.factory.getStrategy(validatedOrder.type);

    // Step 3: Process order
    const processedOrder = strategy.process(validatedOrder);

    // Step 4: Log processing (optional, can be removed for pure functional approach)
    this.logProcessing(validatedOrder.id, validatedOrder.type, processedOrder.status);

    // Step 5: Return result
    return processedOrder;
  }

  /**
   * Processes multiple orders in batch.
   * Returns results for all orders, even if some fail.
   *
   * @param orders - Array of orders to process
   * @returns Array of processing results with success/failure status
   *
   * @example
   * ```typescript
   * const results = processor.processBatch([
   *   { type: 'digital', id: '1' },
   *   { type: 'physical', id: '2' },
   * ]);
   * ```
   */
  processBatch(orders: unknown[]): Array<{ success: boolean; order: ProcessedOrder | null; error?: OrderProcessingError }> {
    // Assume: orders is an array of objects
    // Condition: Processes all orders, collecting results
    // Edge case: orders array is empty - returns empty array

    const results: Array<{ success: boolean; order: ProcessedOrder | null; error?: OrderProcessingError }> = [];

    for (const order of orders) {
      try {
        const processedOrder = this.processOrder(order);
        results.push({ success: true, order: processedOrder });
      } catch (error) {
        results.push({
          success: false,
          order: null,
          error: error instanceof OrderProcessingError ? error : new OrderProcessingError(
            'Unknown error during order processing',
            'UNKNOWN_ERROR',
            { originalError: error }
          ),
        });
      }
    }

    return results;
  }

  /**
   * Returns the internal strategy factory.
   * Useful for testing or advanced configuration.
   *
   * @returns The strategy factory instance
   */
  getFactory(): OrderProcessingStrategyFactory {
    return this.factory;
  }

  /**
   * Returns the processing log.
   *
   * @returns Array of processing log entries
   */
  getProcessingLog(): Array<{ orderId: string; type: string; status: OrderStatus; timestamp: string }> {
    return this.processingLog;
  }

  /**
   * Clears the processing log.
   * Useful for testing or resetting state.
   */
  clearProcessingLog(): void {
    this.processingLog = [];
  }

  /**
   * Logs order processing internally.
   * This can be replaced with a proper logging system.
   *
   * @param orderId - The order ID
   * @param type - The order type
   * @param status - The resulting status
   */
  private logProcessing(orderId: string, type: string, status: OrderStatus): void {
    this.processingLog.push({
      orderId,
      type,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}

// ============================================
// Usage Examples
// ============================================

/**
 * Example 1: Basic usage with default strategies.
 */
function example1_BasicUsage(): void {
  console.log('=== Example 1: Basic Usage ===');

  const processor = new OrderProcessor();

  // Process different order types
  const digitalOrder = processor.processOrder({
    type: 'digital',
    id: 'DIG-001',
    items: ['software license'],
  });

  const physicalOrder = processor.processOrder({
    type: 'physical',
    id: 'PHY-001',
    items: ['laptop'],
    shippingAddress: '123 Main St',
  });

  const subscriptionOrder = processor.processOrder({
    type: 'subscription',
    id: 'SUB-001',
    items: ['monthly service'],
    billingCycle: 'monthly',
  });

  console.log('Digital Order:', digitalOrder);   // { type: 'digital', status: 'delivered', ... }
  console.log('Physical Order:', physicalOrder);  // { type: 'physical', status: 'shipped', ... }
  console.log('Subscription Order:', subscriptionOrder); // { type: 'subscription', status: 'active', ... }
  console.log('');
}

/**
 * Example 2: Handling unknown order types.
 */
function example2_UnknownTypes(): void {
  console.log('=== Example 2: Unknown Order Types ===');

  const processor = new OrderProcessor();

  // Unknown order type (falls back to DefaultOrderStrategy)
  const unknownOrder = processor.processOrder({
    type: 'unknown',
    id: 'UNK-001',
    items: ['something'],
  });

  console.log('Unknown Order:', unknownOrder);    // { type: 'unknown', status: 'pending', requiresManualReview: true, ... }
  console.log('');
}

/**
 * Example 3: Extending with custom strategies (Open/Closed Principle).
 */
function example3_CustomStrategies(): void {
  console.log('=== Example 3: Custom Strategies (OCP) ===');

  // Define a new strategy for service orders
  class ServiceOrderStrategy implements OrderProcessingStrategy {
    process(order: BaseOrder): ProcessedOrder {
      return { ...order, status: OrderStatus.SCHEDULED, processedAt: new Date().toISOString() };
    }
  }

  // Create custom factory with additional strategy
  const customFactory = new OrderProcessingStrategyFactory();
  customFactory.registerStrategy('service', new ServiceOrderStrategy());

  // Create processor with custom factory
  const processor = new OrderProcessor(customFactory);

  // Now we can process service orders
  const serviceOrder = processor.processOrder({
    type: 'service',
    id: 'SRV-001',
    items: ['consultation'],
  });

  console.log('Service Order:', serviceOrder);  // { type: 'service', status: 'scheduled', ... }
  console.log('');
}

/**
 * Example 4: Batch processing with error handling.
 */
function example4_BatchProcessing(): void {
  console.log('=== Example 4: Batch Processing ===');

  const processor = new OrderProcessor();

  const results = processor.processBatch([
    { type: 'digital', id: '1' },
    { type: 'physical', id: '2' },
    { type: 'invalid', id: '' },  // Will fail validation
    null,  // Will fail type check
  ]);

  console.log('Batch Results:', results);
  console.log('Successful:', results.filter(r => r.success).length);
  console.log('Failed:', results.filter(r => !r.success).length);
  console.log('');
}

/**
 * Example 5: Error handling edge cases.
 */
function example5_ErrorHandling(): void {
  console.log('=== Example 5: Error Handling ===');

  const processor = new OrderProcessor();

  // Try invalid order (missing 'type')
  try {
    processor.processOrder({ id: '123' });
  } catch (error) {
    console.log('Caught error for missing type:', error instanceof OrderProcessingError ? error.message : error);
  }

  // Try null order
  try {
    processor.processOrder(null);
  } catch (error) {
    console.log('Caught error for null order:', error instanceof TypeError ? error.message : error);
  }

  console.log('');
}

/**
 * Example 6: Processing log inspection.
 */
function example6_ProcessingLog(): void {
  console.log('=== Example 6: Processing Log ===');

  const processor = new OrderProcessor();

  // Process some orders
  processor.processOrder({ type: 'digital', id: '1' });
  processor.processOrder({ type: 'physical', id: '2' });
  processor.processOrder({ type: 'subscription', id: '3' });

  // Inspect the log
  const log = processor.getProcessingLog();
  console.log('Processing Log:', log);
  console.log('');
}

/**
 * Run all examples.
 */
export function runExamples(): void {
  example1_BasicUsage();
  example2_UnknownTypes();
  example3_CustomStrategies();
  example4_BatchProcessing();
  example5_ErrorHandling();
  example6_ProcessingLog();
}

// ============================================
// Comparison with Original Code
// ============================================

/**
 * ORIGINAL CODE (SOLID Violations):
 *
 * function processOrder(order: any) {
 *   if (order.type === 'digital') {
 *     console.log('Sending email with download link');
 *     order.status = 'delivered';
 *   } else if (order.type === 'physical') {
 *     console.log('Creating shipping label');
 *     order.status = 'shipped';
 *   } else if (order.type === 'subscription') {
 *     console.log('Activating subscription');
 *     order.status = 'active';
 *   }
 *   console.log('Order processed: ' + order.id);
 *   return order;
 * }
 *
 * SOLID VIOLATIONS:
 * - Single Responsibility: Handles multiple order types in one function
 * - Open/Closed: Must modify function to add new order types
 * - Liskov Substitution: No abstraction, relies on concrete conditionals
 * - Interface Segregation: Monolithic function with mixed concerns
 * - Dependency Inversion: Directly depends on concrete order structure
 *
 * OTHER ISSUES:
 * - Uses 'any' type (no type safety)
 * - Mutates input object (not idempotent)
 * - No validation of input
 * - No error handling
 * - Console.log for side effects (not testable)
 * - Cannot handle unknown order types
 * - Hard to test individual behaviors
 */

/**
 * REFACTORED CODE (SOLID Compliant):
 *
 * SOLID PRINCIPLES SATISFIED:
 *
 * Single Responsibility Principle (SRP):
 * - Each strategy handles one type of order
 * - OrderProcessor coordinates but doesn't implement logic
 * - OrderProcessingStrategyFactory manages registration
 *
 * Open/Closed Principle (OCP):
 * - New order types added via new strategies, no code modification
 * - Factory allows runtime registration of strategies
 * - Interface-based design allows easy extension
 *
 * Liskov Substitution Principle (LSP):
 * - All strategies implement the same interface
 * - Strategies are interchangeable without breaking code
 * - DefaultOrderStrategy provides safe fallback behavior
 *
 * Interface Segregation Principle (ISP):
 * - Each interface has focused methods
 * - OrderProcessingStrategy has single method
 * - OrderProcessor has cohesive, related methods
 *
 * Dependency Inversion Principle (DIP):
 * - OrderProcessor depends on OrderProcessingStrategy interface
 * - Concrete strategies injected via factory
 * - Dependencies can be swapped at runtime
 *
 * ADDITIONAL IMPROVEMENTS:
 * - Runtime validation with Zod schemas
 * - Custom error types with context
 * - Immutable operations (returns new objects)
 * - Comprehensive JSDoc documentation
 * - Type safety throughout
 * - Testable design (dependency injection)
 * - Handles unknown order types gracefully
 * - Processing log for debugging
 * - Batch processing support
 * - Clear assumptions and edge case documentation
 */

// Export types for external use
export type {
  BaseOrder,
  ProcessedOrder,
};
