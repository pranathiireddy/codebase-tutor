import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';

export function TopNav() {
  const location = useLocation();
  const { user, logout } = useApp();

  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="app-header sticky top-3 z-30 mx-auto mt-4 h-10 w-[calc(100%-2rem)] max-w-[1280px] rounded-full border border-[#232832] bg-[#0B0D10]/95 backdrop-blur-sm sm:w-[calc(100%-5rem)]">
      <div className="mx-auto flex h-full max-w-[1400px] items-center justify-between gap-8 px-6">
        <Link
          to="/"
          aria-label="Plupus home"
          className="flex items-center gap-2 whitespace-nowrap shrink-0 hover:text-sky-400 transition-colors"
        >
          <img src="/brand/plupus-logo.png" alt="" className="brand-octopus h-7 w-7" />
          <span className="brand-wordmark text-xl leading-none">PLUPUS</span>
        </Link>

        <nav className={`${user ? 'hidden md:flex' : 'flex'} items-center gap-3 text-xs font-medium md:gap-6 md:text-sm`}>
          {user ? (
            <>
              <Link
                to="/"
                className={`whitespace-nowrap shrink-0 transition-colors ${
                  isActive('/') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                Explore
              </Link>
              <Link
                to="/workspace/dietrichgebert__ponytail"
                className={`whitespace-nowrap shrink-0 transition-colors ${
                  location.pathname.startsWith('/workspace') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                Ponytail Demo
              </Link>
              <Link
                to="/docs"
                className={`whitespace-nowrap shrink-0 transition-colors ${
                  isActive('/docs') && location.hash !== '#guide'
                    ? 'text-[#F3F4F6]'
                    : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                Documentation
              </Link>
              <Link
                to="/docs#guide"
                className={`whitespace-nowrap shrink-0 transition-colors ${
                  location.pathname === '/docs' && location.hash === '#guide'
                    ? 'text-[#F3F4F6]'
                    : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                Guide
              </Link>
              <Link
                to="/settings"
                className={`whitespace-nowrap shrink-0 transition-colors ${
                  isActive('/settings') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                Settings
              </Link>
              <button
                type="button"
                onClick={() => void logout()}
                className="whitespace-nowrap shrink-0 cursor-pointer text-[#9CA3AF] transition-colors hover:text-[#F3F4F6]"
              >
                Sign out ({user.name.split(' ')[0]})
              </button>
            </>
          ) : (
            <>
              <Link to="/docs" className="whitespace-nowrap shrink-0 text-[#9CA3AF] transition-colors hover:text-[#F3F4F6]">
                Documentation
              </Link>
              <Link to="/docs#guide" className="whitespace-nowrap shrink-0 text-[#9CA3AF] transition-colors hover:text-[#F3F4F6]">
                Guide
              </Link>
            </>
          )}
        </nav>

        {user && (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => void logout()}
              className="mr-3 whitespace-nowrap text-xs font-medium text-[#9CA3AF] transition-colors hover:text-[#F3F4F6] md:hidden"
            >
              Sign out
            </button>
            <Link
              to="/workspace/dietrichgebert__ponytail"
              className="shrink-0 whitespace-nowrap rounded-md bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-[#0B0D10] transition-colors hover:bg-sky-400"
            >
              Open Workspace
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
