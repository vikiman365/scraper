const Apify = require('apify');
const URL = require('url');

/**
 * Handle the start page (homepage)
 */
async function handleStartPage(context, requestQueue) {
    const { request, $ } = context;
    
    console.log(`Processing start page: ${request.url}`);
    
    // Extract navigation links and category links
    const navLinks = [];
    
    // Look for navigation menus
    $('nav a, .navigation a, .menu a, .category-list a').each((i, element) => {
        const href = $(element).attr('href');
        if (href && !href.startsWith('#') && !href.includes('javascript')) {
            try {
                const absoluteUrl = new URL(href, request.url).href;
                if (absoluteUrl.includes('oncloud.com.mx')) {
                    navLinks.push(absoluteUrl);
                }
            } catch (e) {
                console.warn(`Invalid URL: ${href}`);
            }
        }
    });
    
    // Look for category links in the content
    $('a[href*="category"], a[href*="collection"], a[href*="shop"]').each((i, element) => {
        const href = $(element).attr('href');
        if (href) {
            try {
                const absoluteUrl = new URL(href, request.url).href;
                if (absoluteUrl.includes('oncloud.com.mx') && !navLinks.includes(absoluteUrl)) {
                    navLinks.push(absoluteUrl);
                }
            } catch (e) {
                // Ignore invalid URLs
            }
        }
    });
    
    // Add unique category links to queue
    const uniqueLinks = [...new Set(navLinks)];
    for (const link of uniqueLinks) {
        await requestQueue.addRequest({
            url: link,
            userData: {
                label: 'CATEGORY',
                depth: 1,
                referer: request.url
            }
        });
    }
    
    console.log(`Found ${uniqueLinks.length} category links`);
    
    // Also extract any visible products on homepage
    await extractProductsFromPage(context, requestQueue, 'Homepage');
}

/**
 * Handle product listing pages
 */
async function handleProductList(context, requestQueue, productsDataset) {
    const { request, $ } = context;
    
    console.log(`Processing category page: ${request.url}`);
    
    // Extract category name
    const category = extractCategoryName($, request.url);
    
    // Extract products from the page
    const products = await extractProductsFromPage(context, requestQueue, category);
    
    // Save products to dataset
    if (products.length > 0) {
        for (const product of products) {
            await productsDataset.pushData(product);
        }
        console.log(`Saved ${products.length} products from ${request.url}`);
    }
    
    // Find and enqueue pagination links
    await extractPaginationLinks(context, requestQueue);
}

/**
 * Handle product detail pages
 */
async function handleProductDetail(context, detailedDataset, requestQueue = null) {
    const { request, $ } = context;
    
    console.log(`Processing product detail: ${request.url}`);
    
    const product = {
        url: request.url,
        scrapedAt: new Date().toISOString(),
        category: request.userData?.category || extractCategoryName($, request.url)
    };
    
    // Extract product details
    Object.assign(product, extractProductInfo($));
    Object.assign(product, extractProductPricing($));
    Object.assign(product, extractProductDescription($));
    Object.assign(product, extractProductSpecifications($));
    Object.assign(product, extractProductAvailability($));
    
    // Extract images if requested
    if (requestQueue) {
        Object.assign(product, await extractProductImages($, request.url, requestQueue));
    } else {
        Object.assign(product, extractImageUrls($, request.url));
    }
    
    // Generate unique ID
    product.id = generateProductId(product);
    
    // Save to detailed dataset
    await detailedDataset.pushData(product);
    
    console.log(`Detailed product saved: ${product.name || 'Unknown'}`);
    
    return product;
}

/**
 * Extract products from listing pages
 */
async function extractProductsFromPage(context, requestQueue, category) {
    const { request, $ } = context;
    const products = [];
    
    // Strategy 1: Look for product cards
    $('.product-card, .product-item, .product, [data-product]').each((i, element) => {
        const product = extractProductFromCard($(element), request.url, category);
        if (product && product.name) {
            products.push(product);
            
            // Enqueue product detail page
            const productUrl = findProductDetailUrl($(element), request.url);
            if (productUrl) {
                requestQueue.addRequest({
                    url: productUrl,
                    userData: {
                        label: 'PRODUCT_DETAIL',
                        category: category,
                        listUrl: request.url
                    }
                });
            }
        }
    });
    
    // Strategy 2: Look for product links
    $('a[href*="/product/"], a[href*="/products/"], a[href*="-p-"]').each((i, element) => {
        const $element = $(element);
        const href = $element.attr('href');
        
        if (href) {
            const productUrl = new URL(href, request.url).href;
            
            // Create basic product info from link context
            const product = {
                name: $element.text().trim() || 
                      $element.attr('title') || 
                      $element.find('img').attr('alt') || 
                      'Unknown Product',
                url: productUrl,
                category: category,
                scrapedAt: new Date().toISOString()
            };
            
            // Try to extract price from nearby elements
            const priceText = $element.closest('div').text();
            extractPriceFromText(priceText, product);
            
            products.push(product);
            
            // Enqueue product detail page
            requestQueue.addRequest({
                url: productUrl,
                userData: {
                    label: 'PRODUCT_DETAIL',
                    category: category,
                    listUrl: request.url
                }
            });
        }
    });
    
    return products;
}

/**
 * Extract product information from card element
 */
function extractProductFromCard($element, baseUrl, category) {
    const product = {
        name: $element.find('.product-title, .product-name, h3, h4, .name').first().text().trim(),
        url: baseUrl,
        category: category,
        scrapedAt: new Date().toISOString(),
        id: $element.attr('data-product-id') || $element.attr('data-id') || undefined
    };
    
    // Extract price
    const priceText = $element.text();
    extractPriceFromText(priceText, product);
    
    // Extract image URL
    const img = $element.find('img').first();
    if (img.length) {
        const src = img.attr('src') || img.attr('data-src');
        if (src) {
            product.image = new URL(src, baseUrl).href;
            product.imageAlt = img.attr('alt') || product.name;
        }
    }
    
    return product;
}

/**
 * Find product detail URL from card element
 */
function findProductDetailUrl($element, baseUrl) {
    const href = $element.attr('href') || 
                 $element.find('a').first().attr('href') ||
                 $element.closest('a').attr('href');
    
    if (href && !href.startsWith('#') && !href.includes('javascript')) {
        try {
            return new URL(href, baseUrl).href;
        } catch (e) {
            return null;
        }
    }
    
    return null;
}

/**
 * Extract category name from page
 */
function extractCategoryName($, url) {
    // Try multiple strategies to find category name
    const selectors = [
        '.breadcrumb li:nth-last-child(2)',
        '.category-title',
        '.page-title',
        'h1',
        '.section-title',
        '[data-category]'
    ];
    
    for (const selector of selectors) {
        const element = $(selector).first();
        if (element.length) {
            const text = element.text().trim();
            if (text && !text.includes('MXN') && text.length < 50) {
                return text;
            }
        }
    }
    
    // Extract from URL as fallback
    const urlParts = url.split('/').filter(part => part && !part.includes('oncloud'));
    const lastMeaningfulPart = urlParts[urlParts.length - 1];
    if (lastMeaningfulPart) {
        return lastMeaningfulPart
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }
    
    return 'General';
}

/**
 * Extract pagination links
 */
async function extractPaginationLinks(context, requestQueue) {
    const { request, $ } = context;
    
    $('.pagination a, .next-page, a[href*="page="], a[href*="offset="]').each((i, element) => {
        const href = $(element).attr('href');
        if (href) {
            try {
                const absoluteUrl = new URL(href, request.url).href;
                if (absoluteUrl.includes('oncloud.com.mx')) {
                    requestQueue.addRequest({
                        url: absoluteUrl,
                        userData: {
                            label: 'CATEGORY',
                            depth: request.userData.depth + 1,
                            referer: request.url
                        }
                    });
                }
            } catch (e) {
                // Ignore invalid URLs
            }
        }
    });
}

/**
 * Extract product information
 */
function extractProductInfo($) {
    const info = {};
    
    // Product name
    info.name = $('h1.product-title, h1[itemprop="name"], .product-name').first().text().trim() ||
               $('title').text().split('|')[0].trim();
    
    // SKU/ID
    info.sku = $('[itemprop="sku"], .product-sku, .sku').text().trim() ||
              $('meta[property="product:sku"]').attr('content');
    
    // Brand
    info.brand = $('[itemprop="brand"], .product-brand').text().trim() ||
                $('meta[property="product:brand"]').attr('content') ||
                'On Cloud';
    
    return info;
}

/**
 * Extract product pricing
 */
function extractProductPricing($) {
    const pricing = {};
    
    // Try to find price in the page
    const priceText = $('.price, .product-price, [itemprop="price"], .current-price').text() ||
                     $.html();
    
    extractPriceFromText(priceText, pricing);
    
    // Currency
    pricing.currency = $('[itemprop="priceCurrency"]').attr('content') || 'MXN';
    
    return pricing;
}

/**
 * Extract price from text
 */
function extractPriceFromText(text, targetObject) {
    if (!text) return;
    
    // Original price pattern
    const originalMatch = text.match(/Original price was:\s*([\d,.]+)MXN/i) ||
                         text.match(/Original[^:]*:\s*([\d,.]+)\s*MXN/i) ||
                         text.match(/Antes:\s*([\d,.]+)\s*MXN/i);
    
    // Current price pattern
    const currentMatch = text.match(/Current price is:\s*([\d,.]+)MXN/i) ||
                        text.match(/Precio actual:\s*([\d,.]+)\s*MXN/i) ||
                        text.match(/Ahora:\s*([\d,.]+)\s*MXN/i) ||
                        text.match(/(\d+[\d,.]*)\s*MXN/);
    
    if (originalMatch) {
        targetObject.originalPrice = parseFloat(originalMatch[1].replace(/,/g, ''));
    }
    
    if (currentMatch) {
        targetObject.currentPrice = parseFloat(currentMatch[1].replace(/,/g, ''));
    }
    
    // Calculate discount
    if (targetObject.originalPrice && targetObject.currentPrice) {
        targetObject.discountPercentage = Math.round(
            (1 - targetObject.currentPrice / targetObject.originalPrice) * 100
        );
    }
}

/**
 * Extract product description
 */
function extractProductDescription($) {
    const description = {};
    
    const descriptionSelectors = [
        '[itemprop="description"]',
        '.product-description',
        '.description',
        '.product-info',
        '.product-details'
    ];
    
    for (const selector of descriptionSelectors) {
        const element = $(selector).first();
        if (element.length) {
            description.description = element.text().trim();
            description.descriptionHtml = element.html();
            break;
        }
    }
    
    // Features/Highlights
    const features = [];
    $('.features li, .product-features li, .benefits li, .highlights li').each((i, li) => {
        features.push($(li).text().trim());
    });
    if (features.length > 0) {
        description.features = features;
    }
    
    return description;
}

/**
 * Extract product specifications
 */
function extractProductSpecifications($) {
    const specs = {};
    
    // Extract from tables
    $('table.specifications tr, .specs tr, .attributes tr').each((i, row) => {
        const key = $(row).find('td:first-child, th:first-child').text().trim();
        const value = $(row).find('td:last-child').text().trim();
        if (key && value) {
            specs[key] = value;
        }
    });
    
    // Extract from definition lists
    $('dl dt').each((i, dt) => {
        const key = $(dt).text().trim();
        const value = $(dt).next('dd').text().trim();
        if (key && value) {
            specs[key] = value;
        }
    });
    
    return { specifications: Object.keys(specs).length > 0 ? specs : undefined };
}

/**
 * Extract product availability
 */
function extractProductAvailability($) {
    const availability = {
        inStock: false,
        availabilityText: ''
    };
    
    // Check stock status
    const stockElements = $('.stock, .availability, .in-stock, .out-of-stock');
    if (stockElements.length) {
        availability.availabilityText = stockElements.first().text().trim();
        availability.inStock = !availability.availabilityText.toLowerCase().includes('agotado') &&
                              !availability.availabilityText.toLowerCase().includes('out of stock');
    }
    
    return availability;
}

/**
 * Extract product images (basic method)
 */
function extractImageUrls($, baseUrl) {
    const images = {
        mainImage: '',
        additionalImages: []
    };
    
    // Main image
    const mainImgSelectors = [
        '.main-image img',
        '.product-image img',
        '[itemprop="image"]',
        '.gallery-main img'
    ];
    
    for (const selector of mainImgSelectors) {
        const img = $(selector).first();
        if (img.length) {
            const src = img.attr('src') || img.attr('data-src');
            if (src) {
                images.mainImage = new URL(src, baseUrl).href;
                break;
            }
        }
    }
    
    // Additional images
    $('.thumbnail img, .gallery-thumb img, .product-thumbnails img').each((i, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src');
        if (src && i < 10) { // Limit to 10 images
            images.additionalImages.push(new URL(src, baseUrl).href);
        }
    });
    
    return images;
}

/**
 * Extract product images with lazy loading support
 */
async function extractProductImages($, baseUrl, requestQueue) {
    const images = {
        mainImage: '',
        additionalImages: [],
        allImages: []
    };
    
    // Find all image URLs on the page
    $('img').each((i, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src');
        if (src && src.includes('oncloud') && !src.includes('icon') && !src.includes('logo')) {
            const imageUrl = new URL(src, baseUrl).href;
            images.allImages.push({
                url: imageUrl,
                alt: $(img).attr('alt') || '',
                index: i
            });
        }
    });
    
    // Try to identify main product image
    const likelyMainImages = images.allImages.filter(img => 
        img.url.includes('main') || 
        img.url.includes('primary') ||
        img.alt.toLowerCase().includes('main')
    );
    
    if (likelyMainImages.length > 0) {
        images.mainImage = likelyMainImages[0].url;
    } else if (images.allImages.length > 0) {
        images.mainImage = images.allImages[0].url;
    }
    
    // Additional images (excluding main)
    images.additionalImages = images.allImages
        .filter(img => img.url !== images.mainImage)
        .map(img => img.url)
        .slice(0, 9); // Limit to 9 additional images
    
    return images;
}

/**
 * Generate unique product ID
 */
function generateProductId(product) {
    const base = product.sku || product.name || product.url;
    return Buffer.from(base).toString('base64').substring(0, 20).replace(/[^a-zA-Z0-9]/g, '');
}

module.exports = {
    handleStartPage,
    handleProductList,
    handleProductDetail
};