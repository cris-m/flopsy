# Technical Interview Questions

Organized by domain. Adapt difficulty to the candidate's level.

## Data Structures & Algorithms

### Core Concepts
1. Explain the difference between a hash map and a tree map. When would you use each?
2. How does a hash table handle collisions? Compare chaining vs open addressing.
3. Explain BFS vs DFS — when would you choose one over the other?
4. What is the time complexity of common operations on a balanced BST?
5. Explain how a priority queue works. What data structure backs it?

### Problem-Solving Patterns
6. Given an array of integers, find two numbers that sum to a target. (Two pointer / hash map)
7. Detect a cycle in a linked list. (Floyd's algorithm)
8. Find the longest substring without repeating characters. (Sliding window)
9. Merge k sorted lists. (Heap / divide and conquer)
10. Serialize and deserialize a binary tree. (Preorder traversal + null markers)

### Evaluation Rubric
- Can they identify the pattern? (hash, sliding window, graph traversal, DP)
- Do they discuss trade-offs? (time vs space, readability vs performance)
- Do they handle edge cases? (empty input, single element, duplicates)
- Can they analyze complexity? (Big O for time and space)

## System Knowledge

### Web & APIs
11. Explain what happens when you type a URL in the browser and press Enter.
12. What is the difference between REST and GraphQL?
13. Explain HTTP status codes: 200, 301, 400, 401, 403, 404, 500, 503.
14. What is CORS and why does it exist?
15. Explain the difference between authentication and authorization.

### Databases
16. Explain SQL joins: inner, left, right, full outer.
17. What is database indexing? When would you NOT use an index?
18. Explain ACID properties in databases.
19. When would you choose a NoSQL database over SQL?
20. Explain database normalization vs denormalization trade-offs.

### Infrastructure & DevOps
21. Explain containers vs virtual machines.
22. What is a load balancer and what strategies can it use?
23. Explain CI/CD and why it matters.
24. What is DNS and how does resolution work?
25. Explain caching strategies: write-through, write-back, cache-aside.

## Debugging & Problem Solving

26. A production API is returning 500 errors intermittently. Walk me through how you debug this.
27. A database query that was fast is now slow. What do you check?
28. Users report the app is slow. Where do you start?
29. A deploy broke something but you do not know what changed. How do you investigate?
30. A service is running out of memory. How do you diagnose and fix it?

## Language-Specific (Adapt to User's Stack)

### JavaScript/TypeScript
31. Explain event loop, microtasks, and macrotasks.
32. What is the difference between `==` and `===`?
33. Explain closures and give a practical use case.
34. What are Promises? How do async/await relate to them?
35. Explain prototypal inheritance vs class-based inheritance.

### Python
36. Explain the GIL and its implications for concurrency.
37. What is the difference between a list and a tuple?
38. Explain decorators and give a use case.
39. What are generators and when would you use them?
40. Explain `__init__` vs `__new__`.

### General
41. Explain the SOLID principles. Which do you find most useful in practice?
42. What is dependency injection and why use it?
43. Explain the observer pattern with a real-world example.
44. What is the difference between concurrency and parallelism?
45. Explain immutability — when is it worth the cost?

---

## Evaluation Rubric for Technical Answers

| Dimension | Strong | Needs Work |
|-----------|--------|------------|
| **Accuracy** | Technically correct, precise terminology | Wrong or imprecise, mixes up concepts |
| **Depth** | Goes beyond surface, discusses internals and trade-offs | Surface-level definition only |
| **Practical grounding** | Ties to real experience or concrete examples | Purely theoretical, no application |
| **Trade-off awareness** | Discusses when to use and when NOT to use | Presents as universal solution |
| **Communication** | Clear explanation, builds up from basics | Assumes too much, jumps to conclusions |
