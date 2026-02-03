const Apify = require('apify');
const { handleStartPage, handleProductList, handleProductDetail } = require('./src/pageHandlers');
Apify.main(async () => {
    console.log('✅ Apify.main is working! Starting scraper...');
    // 这里可以先只放一个简单任务，比如访问首页
    const requestQueue = await Apify.openRequestQueue();
    await requestQueue.addRequest({ url: 'https://oncloud.com.mx/' });
    
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        maxRequestsPerCrawl: 1,
        handlePageFunction: async ({ request, $ }) => {
            console.log(`成功访问： ${request.url}`);
            console.log(`页面标题： ${$('title').text()}`);
        },
    });
    
    await crawler.run();
    console.log('🎉 测试运行完成！');
});
    
    // Initialize datasets
    const dataset = await Apify.openDataset();
    const categoriesDataset = await Apify.openDataset('categories');
    const productsDataset = await Apify.openDataset('products');
    const detailedDataset = await Apify.openDataset('detailed-products');
    
    // Initialize request queue
    const requestQueue = await Apify.openRequestQueue();
    
    // Add start URLs
    for (const urlObj of startUrls) {
        await requestQueue.addRequest({
            url: urlObj.url,
            userData: {
                label: 'START',
                depth: 0
            }
        });
    }
    
    // Create crawler
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        maxConcurrency,
        maxRequestRetries: 2,
        requestTimeoutSecs: 30,
        
        // Use Apify Proxy
        proxyConfiguration: await Apify.createProxyConfiguration({
            useApifyProxy: proxyConfiguration.useApifyProxy,
            groups: proxyConfiguration.groups || ['RESIDENTIAL'],
            countryCode: proxyConfiguration.countryCode,
        }),
        
        // Additional headers
        additionalHttpHeaders: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': Apify.utils.getRandomUserAgent(),
        },
        
        // Pre-navigation hooks
        preNavigationHooks: [
            async ({ request }) => {
                // Add delay between requests to avoid rate limiting
                await Apify.utils.sleep(Math.random() * 1000 + 500);
                
                // Update headers
                request.headers = request.headers || {};
                request.headers['User-Agent'] = Apify.utils.getRandomUserAgent();
            }
        ],
        
        // Handle page function
        handlePageFunction: async (context) => {
            const { request, $, response } = context;
            
            console.log(`Processing ${request.url} (${request.userData.label})`);
            
            // Check if we're over product limit
            const datasetInfo = await productsDataset.getInfo();
            if (datasetInfo && datasetInfo.itemCount >= maxProducts) {
                console.log(`Reached maximum product limit (${maxProducts}). Stopping...`);
                return;
            }
            
            // Route to appropriate handler based on label or URL pattern
            switch (request.userData.label) {
                case 'START':
                    await handleStartPage(context, requestQueue);
                    break;
                    
                case 'CATEGORY':
                    await handleProductList(context, requestQueue, productsDataset);
                    break;
                    
                case 'PRODUCT_DETAIL':
                    if (includeImages) {
                        await handleProductDetail(context, detailedDataset, requestQueue);
                    } else {
                        await handleProductDetail(context, detailedDataset);
                    }
                    break;
                    
                default:
                    // Auto-detect page type
                    if (request.url.includes('/product/') || 
                        request.url.includes('/products/') ||
                        $('.product-detail, [data-product-id], .product-view').length > 0) {
                        if (includeImages) {
                            await handleProductDetail(context, detailedDataset, requestQueue);
                        } else {
                            await handleProductDetail(context, detailedDataset);
                        }
                    } else {
                        await handleProductList(context, requestQueue, productsDataset);
                    }
            }
        },
        
        // Error handling
        handleFailedRequestFunction: async ({ request, error }) => {
            console.error(`Failed to process ${request.url}:`, error.message);
            
            // Log error to dataset
            await dataset.pushData({
                type: 'error',
                url: request.url,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        },
    });
    
    // Run the crawler
    console.log('Starting crawler...');
    await crawler.run();
    
    // Organize data by category
    await organizeDataByCategory(productsDataset, categoriesDataset, detailedDataset);
    
    // Generate summary report
    await generateSummary(dataset, productsDataset, categoriesDataset, detailedDataset);
    
    console.log('Scraping completed successfully!');
});

/**
 * Organize scraped data by category
 */
async function organizeDataByCategory(productsDataset, categoriesDataset, detailedDataset) {
    console.log('Organizing data by category...');
    
    // Get all products
    const { items: products } = await productsDataset.getData();
    
    // Group products by category
    const categories = {};
    
    products.forEach(product => {
        const category = product.category || 'Uncategorized';
        
        if (!categories[category]) {
            categories[category] = {
                categoryName: category,
                productCount: 0,
                productIds: [],
                priceRange: {
                    min: Infinity,
                    max: 0,
                    average: 0
                },
                totalDiscount: 0
            };
        }
        
        categories[category].productCount++;
        categories[category].productIds.push(product.id || product.name);
        
        // Update price statistics
        if (product.currentPrice) {
            categories[category].priceRange.min = Math.min(
                categories[category].priceRange.min, 
                product.currentPrice
            );
            categories[category].priceRange.max = Math.max(
                categories[category].priceRange.max, 
                product.currentPrice
            );
            
            if (product.discountPercentage) {
                categories[category].totalDiscount += product.discountPercentage;
            }
        }
    });
    
    // Calculate average price and discount
    for (const [categoryName, categoryData] of Object.entries(categories)) {
        const prices = products
            .filter(p => (p.category || 'Uncategorized') === categoryName && p.currentPrice)
            .map(p => p.currentPrice);
        
        if (prices.length > 0) {
            const sum = prices.reduce((a, b) => a + b, 0);
            categoryData.priceRange.average = Math.round((sum / prices.length) * 100) / 100;
        }
        
        if (categoryData.productCount > 0) {
            categoryData.averageDiscount = Math.round(
                categoryData.totalDiscount / categoryData.productCount
            );
        }
        
        // Save category data
        await categoriesDataset.pushData(categoryData);
    }
    
    console.log(`Organized ${products.length} products into ${Object.keys(categories).length} categories`);
}

/**
 * Generate scraping summary
 */
async function generateSummary(dataset, productsDataset, categoriesDataset, detailedDataset) {
    console.log('Generating summary...');
    
    const productsInfo = await productsDataset.getInfo();
    const categoriesInfo = await categoriesDataset.getInfo();
    const detailedInfo = await detailedDataset.getInfo();
    
    const summary = {
        timestamp: new Date().toISOString(),
        totalProducts: productsInfo?.itemCount || 0,
        totalCategories: categoriesInfo?.itemCount || 0,
        detailedProducts: detailedInfo?.itemCount || 0,
        statistics: {
            productsPerCategory: Math.round(
                (productsInfo?.itemCount || 0) / (categoriesInfo?.itemCount || 1)
            ),
            successRate: detailedInfo?.itemCount > 0 ? 
                Math.round((detailedInfo.itemCount / productsInfo.itemCount) * 100) : 0
        }
    };
    
    // Save summary to default dataset
    await dataset.pushData({
        type: 'summary',
        ...summary
    });
    
    console.log('Summary:', summary);

}
