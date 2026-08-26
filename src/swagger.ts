import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "BearthApi",
      version: "2.0.0",
      description: "Bearth NFT admin API",
    },
    servers: [{ url: "http://localhost:8000", description: "Local dev" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", example: "admin@bearth.local" },
            password: { type: "string", example: "Admin2024!" },
          },
        },
        LoginResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            role: { type: "string", enum: ["admin", "ops", "tech"] },
            userId: { type: "string", format: "uuid" },
            success: { type: "boolean" },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            email: { type: "string" },
            name: { type: "string" },
            roleId: { type: "string", format: "uuid" },
            isActive: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Role: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            code: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
          },
        },
        Permission: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            code: { type: "string" },
            name: { type: "string" },
            module: { type: "string" },
          },
        },
        Menu: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            label: { type: "string" },
            path: { type: "string" },
            icon: { type: "string" },
            permissionCode: { type: "string" },
            sortOrder: { type: "integer" },
          },
        },
        Customer: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string" },
            walletAddress: { type: "string" },
            referrerId: { type: "string", format: "uuid" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Product: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            description: { type: "string" },
            price: { type: "number" },
            stock: { type: "integer" },
            isActive: { type: "boolean" },
          },
        },
        Order: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            customerId: { type: "string", format: "uuid" },
            status: { type: "string" },
            totalAmount: { type: "number" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        NftEntry: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            customerId: { type: "string", format: "uuid" },
            walletAddress: { type: "string" },
            quantity: { type: "integer" },
            paymentStatus: { type: "string" },
          },
        },
      },
    },
    paths: {
      // ── Health ────────────────────────────────────────────────────────────
      "/api/health": {
        get: {
          tags: ["System"],
          summary: "Health check",
          responses: { "200": { description: "API is running", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", example: "ok" } } } } } } },
        },
      },

      // ── Auth ──────────────────────────────────────────────────────────────
      "/api/auth/admin/login": {
        post: {
          tags: ["Auth"],
          summary: "Login with email + password",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } } },
          responses: {
            "200": { description: "JWT token", content: { "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } } } },
            "401": { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { description: "No admin access", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/auth/admin/me": {
        get: {
          tags: ["Auth"],
          summary: "Get current user context (menus + permissions)",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "User context with menus and permissions" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/api/auth/session": {
        post: {
          tags: ["Auth"],
          summary: "Create wallet session (whitelist admin)",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { address: { type: "string" } } } } } },
          responses: { "200": { description: "Session created" }, "403": { description: "Not admin address" } },
        },
        delete: {
          tags: ["Auth"],
          summary: "Clear wallet session",
          responses: { "200": { description: "Session cleared" } },
        },
      },
      "/api/auth/verify": {
        get: {
          tags: ["Auth"],
          summary: "Verify wallet session cookie",
          responses: { "200": { description: "Verification result" } },
        },
      },
      "/api/auth/admin/forgot-password": {
        post: {
          tags: ["Auth"],
          summary: "Send password reset email",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email", example: "admin@bearth.local" } } } } } },
          responses: {
            "200": { description: "Reset email sent (always returns success to prevent user enumeration)" },
            "400": { description: "Email is required" },
            "500": { description: "Email delivery failed" },
          },
        },
      },
      "/api/auth/admin/reset-password": {
        post: {
          tags: ["Auth"],
          summary: "Reset password using token from email",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["token", "password"], properties: { token: { type: "string" }, password: { type: "string", minLength: 8 } } } } } },
          responses: {
            "200": { description: "Password reset successfully" },
            "400": { description: "Invalid or expired token" },
          },
        },
      },

      // ── Admin: Roles ──────────────────────────────────────────────────────
      "/api/admin/roles": {
        get: {
          tags: ["Admin - Roles"],
          summary: "List all roles",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Roles list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Role" } } } } } },
        },
        post: {
          tags: ["Admin - Roles"],
          summary: "Create a role",
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Role" } } } },
          responses: { "201": { description: "Role created" } },
        },
      },
      "/api/admin/roles/{id}": {
        put: {
          tags: ["Admin - Roles"],
          summary: "Update a role",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Role" } } } },
          responses: { "200": { description: "Role updated" } },
        },
        delete: {
          tags: ["Admin - Roles"],
          summary: "Delete a role",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Role deleted" } },
        },
      },

      // ── Admin: Permissions ────────────────────────────────────────────────
      "/api/admin/permissions": {
        get: {
          tags: ["Admin - Permissions"],
          summary: "List all permissions",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Permissions list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Permission" } } } } } },
        },
      },
      "/api/admin/permissions/role/{roleId}": {
        get: {
          tags: ["Admin - Permissions"],
          summary: "Get permissions for a role",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "roleId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Role permissions" } },
        },
        put: {
          tags: ["Admin - Permissions"],
          summary: "Set permissions for a role",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "roleId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { permissionIds: { type: "array", items: { type: "string", format: "uuid" } } } } } } },
          responses: { "200": { description: "Permissions updated" } },
        },
      },

      // ── Admin: Menus ──────────────────────────────────────────────────────
      "/api/admin/menus": {
        get: {
          tags: ["Admin - Menus"],
          summary: "List all menus",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Menus list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Menu" } } } } } },
        },
        post: {
          tags: ["Admin - Menus"],
          summary: "Create a menu item",
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Menu" } } } },
          responses: { "201": { description: "Menu created" } },
        },
      },
      "/api/admin/menus/{id}": {
        put: {
          tags: ["Admin - Menus"],
          summary: "Update a menu item",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Menu" } } } },
          responses: { "200": { description: "Menu updated" } },
        },
        delete: {
          tags: ["Admin - Menus"],
          summary: "Delete a menu item",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Menu deleted" } },
        },
      },

      // ── Admin: Users ──────────────────────────────────────────────────────
      "/api/admin/users": {
        get: {
          tags: ["Admin - Users"],
          summary: "List admin users",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Users list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/User" } } } } } },
        },
        post: {
          tags: ["Admin - Users"],
          summary: "Create an admin user",
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email", "name", "password", "roleId"], properties: { email: { type: "string" }, name: { type: "string" }, password: { type: "string" }, roleId: { type: "string", format: "uuid" } } } } } },
          responses: { "201": { description: "User created" } },
        },
      },
      "/api/admin/users/{id}": {
        put: {
          tags: ["Admin - Users"],
          summary: "Update an admin user",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "User updated" } },
        },
        delete: {
          tags: ["Admin - Users"],
          summary: "Delete an admin user",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "User deleted" } },
        },
      },

      // ── Presale: Customers ────────────────────────────────────────────────
      "/api/customers": {
        get: {
          tags: ["Presale - Customers"],
          summary: "List customers",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
            { name: "search", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Paginated customers" } },
        },
        post: {
          tags: ["Presale - Customers"],
          summary: "Create a customer",
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } } },
          responses: { "201": { description: "Customer created" } },
        },
      },
      "/api/customers/{id}": {
        get: {
          tags: ["Presale - Customers"],
          summary: "Get customer by ID",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Customer detail" }, "404": { description: "Not found" } },
        },
        put: {
          tags: ["Presale - Customers"],
          summary: "Update a customer",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Customer updated" } },
        },
        delete: {
          tags: ["Presale - Customers"],
          summary: "Delete a customer",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Customer deleted" } },
        },
      },

      // ── Presale: Orders ───────────────────────────────────────────────────
      "/api/orders": {
        get: {
          tags: ["Presale - Orders"],
          summary: "List orders",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
            { name: "status", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Paginated orders" } },
        },
        post: {
          tags: ["Presale - Orders"],
          summary: "Create an order",
          security: [{ bearerAuth: [] }],
          responses: { "201": { description: "Order created" } },
        },
      },
      "/api/orders/{id}": {
        get: {
          tags: ["Presale - Orders"],
          summary: "Get order by ID",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Order detail" } },
        },
        put: {
          tags: ["Presale - Orders"],
          summary: "Update an order",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Order updated" } },
        },
      },

      // ── Presale: Products ─────────────────────────────────────────────────
      "/api/products": {
        get: {
          tags: ["Presale - Products"],
          summary: "List products",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Products list" } },
        },
        post: {
          tags: ["Presale - Products"],
          summary: "Create a product",
          security: [{ bearerAuth: [] }],
          responses: { "201": { description: "Product created" } },
        },
      },
      "/api/products/{id}": {
        get: {
          tags: ["Presale - Products"],
          summary: "Get product by ID",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Product detail" } },
        },
        put: {
          tags: ["Presale - Products"],
          summary: "Update a product",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Product updated" } },
        },
        delete: {
          tags: ["Presale - Products"],
          summary: "Delete a product",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Product deleted" } },
        },
      },

      // ── Presale: NFT ──────────────────────────────────────────────────────
      "/api/nft": {
        get: {
          tags: ["Presale - NFT"],
          summary: "List NFT entries",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "NFT entries" } },
        },
      },
      "/api/nft/{id}/confirm-payment": {
        post: {
          tags: ["Presale - NFT"],
          summary: "Confirm NFT payment",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Payment confirmed" } },
        },
      },
      "/api/nft/{id}/confirm-delivery": {
        post: {
          tags: ["Presale - NFT"],
          summary: "Confirm NFT delivery",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Delivery confirmed" } },
        },
      },

      // ── Presale: Referrers ────────────────────────────────────────────────
      "/api/referrers": {
        get: {
          tags: ["Presale - Referrers"],
          summary: "List referrers",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Referrers list" } },
        },
        post: {
          tags: ["Presale - Referrers"],
          summary: "Create a referrer",
          security: [{ bearerAuth: [] }],
          responses: { "201": { description: "Referrer created" } },
        },
      },

      // ── Presale: Master ───────────────────────────────────────────────────
      "/api/master": {
        get: {
          tags: ["Presale - Master"],
          summary: "Get master/lookup data (countries, payment methods, etc.)",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Master data" } },
        },
      },

      // ── Presale: Reconciliation ───────────────────────────────────────────
      "/api/reconciliation": {
        get: {
          tags: ["Presale - Reconciliation"],
          summary: "List reconciliation records",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Reconciliation list" } },
        },
      },

      // ── Presale: Reports ──────────────────────────────────────────────────
      "/api/reports": {
        get: {
          tags: ["Presale - Reports"],
          summary: "Get report data",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "type", in: "query", schema: { type: "string", enum: ["sales", "nft", "customers", "referrers"] } }],
          responses: { "200": { description: "Report data" } },
        },
      },

      // ── Admin: Users (admin users via core router) ───────────────────
      "/api/users": {
        get: {
          tags: ["Presale - Users"],
          summary: "List admin users (admin context)",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Users list" } },
        },
        post: {
          tags: ["Presale - Users"],
          summary: "Create admin user (admin context)",
          security: [{ bearerAuth: [] }],
          responses: { "201": { description: "User created" } },
        },
      },

      // ── Presale: Waves ───────────────────────────────────────────────────
      "/api/waves": {
        get: {
          tags: ["Presale - Waves"],
          summary: "List NFT waves",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Waves list" } },
        },
        post: {
          tags: ["Presale - Waves"],
          summary: "Create an NFT wave",
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["waveNumber", "name", "quantity"], properties: { waveNumber: { type: "integer" }, name: { type: "string" }, quantity: { type: "integer" }, defaultPriceEth: { type: "number" }, saleMethod: { type: "string", enum: ["fixed_price", "english_auction", "free_mint"] }, scheduledStart: { type: "string", format: "date-time" }, scheduledEnd: { type: "string", format: "date-time" }, status: { type: "string", enum: ["upcoming", "active", "paused", "completed", "cancelled"] } } } } } },
          responses: { "201": { description: "Wave created" } },
        },
      },
      "/api/waves/{id}": {
        get: {
          tags: ["Presale - Waves"],
          summary: "Get wave by ID",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Wave detail" }, "404": { description: "Not found" } },
        },
        put: {
          tags: ["Presale - Waves"],
          summary: "Update a wave",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Wave updated" } },
        },
        delete: {
          tags: ["Presale - Waves"],
          summary: "Delete a wave",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Wave deleted" } },
        },
      },

      // ── NFT Generator ─────────────────────────────────────────────────────
      "/api/nft-gen/collections": {
        get: {
          tags: ["NFT Generator"],
          summary: "List NFT collections",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Collections list" } },
        },
        post: {
          tags: ["NFT Generator"],
          summary: "Create a collection",
          security: [{ bearerAuth: [] }],
          responses: { "201": { description: "Collection created" } },
        },
      },
      "/api/nft-gen/collections/{id}": {
        get: {
          tags: ["NFT Generator"],
          summary: "Get collection by ID",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Collection detail" } },
        },
        put: {
          tags: ["NFT Generator"],
          summary: "Update a collection",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Collection updated" } },
        },
      },
      "/api/nft-gen/collections/{id}/layers": {
        get: {
          tags: ["NFT Generator"],
          summary: "List layers for a collection",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Layers list" } },
        },
        post: {
          tags: ["NFT Generator"],
          summary: "Create a layer",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "201": { description: "Layer created" } },
        },
      },
      "/api/nft-gen/layers/{id}/traits": {
        get: {
          tags: ["NFT Generator"],
          summary: "List traits for a layer",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Traits list" } },
        },
        post: {
          tags: ["NFT Generator"],
          summary: "Create a trait",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "201": { description: "Trait created" } },
        },
      },
      "/api/nft-gen/collections/{id}/generate": {
        post: {
          tags: ["NFT Generator"],
          summary: "Start async generation job",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { size: { type: "integer", description: "Number of NFTs to generate" } } } } } },
          responses: { "202": { description: "Job started", content: { "application/json": { schema: { type: "object", properties: { jobId: { type: "string", format: "uuid" } } } } } } },
        },
      },
      "/api/nft-gen/jobs/{id}": {
        get: {
          tags: ["NFT Generator"],
          summary: "Poll generation job status",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Job status with progress 0–100" } },
        },
      },

      // ── Whitelist ─────────────────────────────────────────────────────────
      "/api/whitelist": {
        get: {
          tags: ["Whitelist"],
          summary: "Get whitelist state (root + address count)",
          responses: { "200": { description: "Whitelist state" } },
        },
      },
      "/api/whitelist/addresses": {
        get: {
          tags: ["Whitelist"],
          summary: "List all whitelisted addresses",
          responses: { "200": { description: "Address list" } },
        },
        post: {
          tags: ["Whitelist"],
          summary: "Add wallet address to whitelist",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { address: { type: "string" } } } } } },
          responses: { "201": { description: "Address added" } },
        },
      },
      "/api/whitelist/addresses/{address}": {
        delete: {
          tags: ["Whitelist"],
          summary: "Remove wallet address from whitelist",
          parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Address removed" } },
        },
      },

      // ── Proof ─────────────────────────────────────────────────────────────
      "/api/proof": {
        get: {
          tags: ["Whitelist"],
          summary: "Get Merkle proof for a wallet address",
          parameters: [{ name: "address", in: "query", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Merkle proof array", content: { "application/json": { schema: { type: "object", properties: { proof: { type: "array", items: { type: "string" } }, address: { type: "string" } } } } } },
            "404": { description: "Address not in whitelist" },
          },
        },
      },
    },
  },
  apis: [],
};

export const swaggerSpec = swaggerJsdoc(options);
