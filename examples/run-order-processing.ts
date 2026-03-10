#!/usr/bin/env tsx
// Practical usage example for Strategy Pattern Order Processing

import { OrderProcessor, OrderProcessingStrategy } from './refactored-order-processing';

// Example: Defining a custom order type and strategy
class GiftCardOrderStrategy implements OrderProcessingStrategy {
  process(order: any): any {
    return { ...order, status: 'available', expiryDate: '365 days from now' };
  }
}

// Create processor and add custom strategy
const processor = new OrderProcessor();
processor.addStrategy('gift_card', new GiftCardOrderStrategy());

// Process various orders
const orders = [
  { type: 'digital', id: 1, item: 'software' },
  { type: 'physical', id: 2, item: 'book', address: '123 Main St' },
  { type: 'subscription', id: 3, item: 'streaming' },
  { type: 'gift_card', id: 4, item: '$50 card' },
  { type: 'custom', id: 5, item: 'special request' },  // Unknown type falls back to 'pending'
];

console.log('=== Processing Orders ===\n');
orders.forEach((order) => {
  const result = processor.processOrder(order);
  console.log(`ID: ${result.id} | Type: ${result.type} | Status: ${result.status}`);
  if (result.expiryDate) {
    console.log(`  Expires: ${result.expiryDate}`);
  }
  console.log('');
});

// Output:
// === Processing Orders ===
//
// ID: 1 | Type: digital | Status: delivered
//
// ID: 2 | Type: physical | Status: shipped
//
// ID: 3 | Type: subscription | Status: active
//
// ID: 4 | Type: gift_card | Status: available
//   Expires: 365 days from now
//
// ID: 5 | Type: custom | Status: pending
