const express = require('express');
const { Pool } = require('pg');
const router = express.Router();

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'stock_inventory',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Generate top 20 rankings for a category and month
router.post('/generate-rankings', async (req, res) => {
  try {
    const { month } = req.body;

    // Get top 20 products per category
    const categories = ['MOBIL 1', 'TIRES & LUBRICANT'];
    
    for (const category of categories) {
      const topProducts = await pool.query(
        `SELECT s.product_id, s.quantity_sold, s.total_sales
         FROM sales s
         JOIN products p ON s.product_id = p.id
         WHERE p.category = $1 AND s.month = $2
         ORDER BY s.quantity_sold DESC
         LIMIT 20`,
        [category, month]
      );

      // Insert rankings
      for (let rank = 0; rank < topProducts.rows.length; rank++) {
        const { product_id, quantity_sold, total_sales } = topProducts.rows[rank];
        await pool.query(
          `INSERT INTO rankings (product_id, category, month, rank, quantity_sold, total_sales)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (product_id, category, month) DO UPDATE
           SET rank = $4, quantity_sold = $5, total_sales = $6
           RETURNING *`,
          [product_id, category, month, rank + 1, quantity_sold, total_sales]
        );
      }
    }

    res.json({ message: 'Rankings generated successfully' });
  } catch (error) {
    console.error('Error generating rankings:', error);
    res.status(500).json({ error: 'Failed to generate rankings' });
  }
});

// Get top 20 by category and month
router.get('/top20/:category/:month', async (req, res) => {
  try {
    const { category, month } = req.params;
    const result = await pool.query(
      `SELECT r.*, p.sku, p.name
       FROM rankings r
       JOIN products p ON r.product_id = p.id
       WHERE r.category = $1 AND r.month = $2
       ORDER BY r.rank`,
      [category, month]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching rankings:', error);
    res.status(500).json({ error: 'Failed to fetch rankings' });
  }
});

// Generate reorder suggestions based on sales
router.post('/generate-reorder-suggestions', async (req, res) => {
  try {
    const { month } = req.body;

    // Get previous month for comparison
    const [year, monthNum] = month.split('-');
    const prevMonth = monthNum === '01' ? `${year - 1}-12` : `${year}-${String(parseInt(monthNum) - 1).padStart(2, '0')}`;

    // Get all products with their sales data
    const products = await pool.query('SELECT * FROM products');

    for (const product of products.rows) {
      // Get current month sales
      const currentSales = await pool.query(
        'SELECT quantity_sold FROM sales WHERE product_id = $1 AND month = $2',
        [product.id, month]
      );

      // Get previous month sales for trend
      const prevSales = await pool.query(
        'SELECT quantity_sold FROM sales WHERE product_id = $1 AND month = $2',
        [product.id, prevMonth]
      );

      const currentQuantity = currentSales.rows[0]?.quantity_sold || 0;
      const prevQuantity = prevSales.rows[0]?.quantity_sold || 0;

      // Calculate suggested reorder quantity (150% of current month if trending up, 100% if stable)
      let suggestedQuantity = currentQuantity;
      if (currentQuantity > prevQuantity) {
        suggestedQuantity = Math.ceil(currentQuantity * 1.5);
      }

      // Insert or update suggestion
      await pool.query(
        `INSERT INTO reorder_suggestions (product_id, month, suggested_quantity, previous_month_sales)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, month) DO UPDATE
         SET suggested_quantity = $3, previous_month_sales = $4, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [product.id, month, suggestedQuantity, prevQuantity]
      );
    }

    res.json({ message: 'Reorder suggestions generated successfully' });
  } catch (error) {
    console.error('Error generating reorder suggestions:', error);
    res.status(500).json({ error: 'Failed to generate reorder suggestions' });
  }
});

// Get reorder suggestions for a month
router.get('/reorder-suggestions/:month', async (req, res) => {
  try {
    const { month } = req.params;
    const result = await pool.query(
      `SELECT rs.*, p.sku, p.name, p.category
       FROM reorder_suggestions rs
       JOIN products p ON rs.product_id = p.id
       WHERE rs.month = $1
       ORDER BY p.category, p.name`,
      [month]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching reorder suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch reorder suggestions' });
  }
});

// Get overall analytics/dashboard data
router.get('/dashboard/:month', async (req, res) => {
  try {
    const { month } = req.params;

    // Total sales by category
    const categorySales = await pool.query(
      `SELECT p.category, SUM(s.total_sales) as total_sales, SUM(s.quantity_sold) as total_quantity
       FROM sales s
       JOIN products p ON s.product_id = p.id
       WHERE s.month = $1
       GROUP BY p.category`,
      [month]
    );

    // Top 5 products
    const topProducts = await pool.query(
      `SELECT p.name, p.category, s.quantity_sold, s.total_sales
       FROM sales s
       JOIN products p ON s.product_id = p.id
       WHERE s.month = $1
       ORDER BY s.quantity_sold DESC
       LIMIT 5`,
      [month]
    );

    // Total inventory value
    const inventoryValue = await pool.query(
      `SELECT SUM(total_stock_on_hand) as total_value
       FROM inventory
       WHERE month = $1`,
      [month]
    );

    res.json({
      sales_by_category: categorySales.rows,
      top_products: topProducts.rows,
      total_inventory_value: inventoryValue.rows[0]?.total_value || 0
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
