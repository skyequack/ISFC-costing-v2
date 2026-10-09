import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'legacy/**',
      'golden/**',
      'tools/**',
      'prisma/seed-data/**',
      'next-env.d.ts',
      'coverage/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // src/domain is pure TS: no framework, DB, auth or browser imports (docs/ARCHITECTURE.md §1)
    files: ['src/domain/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['react', 'react-dom', 'next', 'next/*', '@prisma/*', '@clerk/*', '@/lib/*', '@/components/*'] },
      ],
    },
  },
];

export default config;
