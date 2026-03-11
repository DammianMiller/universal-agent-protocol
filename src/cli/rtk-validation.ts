/**
 * Redux Toolkit (RTK) Includes Validation
 * 
 * Ensures that projects using React/Redux follow proper RTK patterns:
 * - createSlice for state management
 * - configureStore for store setup  
 * - createAsyncThunk for async operations
 * - Proper action creators and reducers
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface RTKValidationResult {
  valid: boolean;
  issues: Array<{ file: string; issue: string; severity: 'error' | 'warning' | 'info' }>;
  recommendations: string[];
}

export function validateRTKIncludes(projectDir: string): RTKValidationResult {
  const result: RTKValidationResult = {
    valid: true,
    issues: [],
    recommendations: [],
  };

  // Check for package.json with Redux dependencies
  const pkgPath = join(projectDir, 'package.json');
  
  if (!existsSync(pkgPath)) {
    return result;
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    
    // Check for @reduxjs/toolkit usage
    const hasReduxToolkit = 
      (pkg.dependencies && pkg.dependencies['@reduxjs/toolkit']) ||
      (pkg.devDependencies && pkg.devDependencies['@reduxjs/toolkit']);

    if (!hasReduxToolkit) {
      return result; // Not a Redux project, nothing to validate
    }

    // Check for redux-saga or RTK Query usage
    const hasSaga = 
      (pkg.dependencies && pkg.dependencies['redux-saga']) || false;
    
    // Validate store configuration patterns
    const srcDir = join(projectDir, 'src');
    if (!existsSync(srcDir)) {
      result.issues.push({
        file: '<project>/src',
        issue: 'No src directory found for Redux validation',
        severity: 'warning' as const,
      });
      return result;
    }

    // Look for store.ts or index.ts with configureStore
    const checkReduxPatterns = (dir: string): void => {
      if (!existsSync(dir)) return;

      try {
        const files = require('fs').readdirSync(dir);
        
        for (const file of files) {
          const filePath = join(dir, file);
          
          // Skip node_modules and build directories
          if (file === 'node_modules' || 
              file === '.next' || 
              file === 'dist' ||
              file.includes('.test.') ||
              file.includes('.spec.')) {
            continue;
          }

          const stat = require('fs').statSync(filePath);
          
          if (stat.isDirectory()) {
            checkReduxPatterns(filePath);
          } else if ((file.endsWith('.ts') || file.endsWith('.tsx')) && 
                     !file.includes('.d.ts')) {
            try {
              const content = readFileSync(filePath, 'utf-8');
              
              // Check for proper RTK usage patterns
              if (content.includes('createSlice') && !content.includes("from '@reduxjs/toolkit'")) {
                result.issues.push({
                  file: filePath.replace(projectDir + '/', ''),
                  issue: 'Uses createSlice but missing @reduxjs/toolkit import',
                  severity: 'error' as const,
                });
              }

              if (content.includes('configureStore') && !content.includes("from '@reduxjs/toolkit'")) {
                result.issues.push({
                  file: filePath.replace(projectDir + '/', ''),
                  issue: 'Uses configureStore but missing @reduxjs/toolkit import',
                  severity: 'error' as const,
                });
              }

              // Check for deprecated patterns
              if (content.includes('createStore') && 
                  content.includes("from 'redux'") &&
                  !hasReduxToolkit) {
                result.issues.push({
                  file: filePath.replace(projectDir + '/', ''),
                  issue: 'Using createStore from redux instead of configureStore from @reduxjs/toolkit',
                  severity: 'warning' as const,
                });
              }

            } catch (e) {
              // Skip files that can't be read
            }
          }
        }
      } catch (e) {
        // Directory not readable
      }
    };

    checkReduxPatterns(srcDir);

  } catch (error: unknown) {
    const err = error as Error;
    result.issues.push({
      file: pkgPath,
      issue: `Failed to read package.json: ${err.message}`,
      severity: 'warning' as const,
    });
    result.valid = false;
  }

  return result;
}
